// F165 idle-workers (R40.1-R40.3): a build where no route can call a worker (no loader, no job, no actions app, no
// cache adapter) writes `needs_workers: false`, and `brust start` spawns no worker: it serves every page exactly as the
// same build with a worker pool does, and drains at once on SIGTERM. One loader keeps the pool. A manifest without the
// bit (older builds) keeps the pool, and a worker call that reaches a pool-less server (a hand-edited manifest) answers
// 503 at once instead of waiting. Run alone: `bun test --timeout 180000 tests/server/idle-workers.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const app = join(import.meta.dir, '../fixtures/shadcn')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
const STATIC = { dist: '.rows/dist-idle-workers', entry: 'started/idle-workers-routes.tsx' }
const LOADER = { dist: '.rows/dist-idle-workers-loader', entry: 'started/idle-workers-loader-routes.tsx' }
const ISLAND = { dist: '.rows/dist-idle-workers-island', entry: 'started/idle-workers-island-routes.tsx' }
const FORCED = '.rows/dist-idle-workers-forced'
const STRAY = '.rows/dist-idle-workers-stray'
const NOPOOL = '.rows/dist-idle-workers-island-nopool'
const PAGES = ['/', '/about', '/count', '/missing']

type Server = { base: string; log: () => string; proc: ReturnType<typeof Bun.spawn> }
const live = new Set<Server>()

function build(o: { dist: string; entry: string }) {
  const b = Bun.spawnSync([bin, 'build', o.entry, '--out-dir', o.dist], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}`)
}

const manifestOf = (dist: string) => JSON.parse(readFileSync(join(app, dist, 'manifest.json'), 'utf8'))

/** A copy of `from` whose manifest is edited by `edit` (the server reads only the copy). */
function variant(from: string, to: string, edit: (m: Record<string, unknown>) => void) {
  rmSync(join(app, to), { recursive: true, force: true })
  cpSync(join(app, from), join(app, to), { recursive: true })
  const m = manifestOf(to)
  edit(m)
  writeFileSync(join(app, to, 'manifest.json'), `${JSON.stringify(m, null, 2)}\n`)
}

async function start(dist: string, entry: string): Promise<Server> {
  const env = { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '', NODE_ENV: 'production' }
  const proc = Bun.spawn([bin, 'start', '--port', '0', '--workers', '2', '--dist-dir', dist, '--entry', entry], { cwd: app, env, stdout: 'pipe', stderr: 'pipe' })
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  let out = ''
  while (!/\[brust\] ready/.test(out) || !/listening on (\S+)/.test(out)) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`brust start exited before ready:\n${out}\n${await new Response(proc.stderr as ReadableStream).text()}`)
    out += dec.decode(value, { stream: true })
  }
  void (async () => {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      out += dec.decode(value, { stream: true })
    }
  })()
  const s: Server = { base: `http://${/listening on (\S+)/.exec(out)![1]}`, log: () => out, proc }
  live.add(s)
  return s
}

async function stop(s: Server) {
  live.delete(s)
  s.proc.kill('SIGINT')
  if ((await Promise.race([s.proc.exited, Bun.sleep(5000).then(() => undefined)])) === undefined) {
    s.proc.kill('SIGKILL')
    await s.proc.exited
  }
}

/** Status, body and every header but the ones that differ per response. */
async function snapshot(base: string, path: string) {
  const r = await fetch(`${base}${path}`, { redirect: 'manual' })
  const headers = [...r.headers.entries()].filter(([k]) => k !== 'date').sort()
  return { status: r.status, headers, body: await r.text() }
}

beforeAll(() => {
  build(STATIC)
  build(LOADER)
  build(ISLAND)
}, 180_000)

afterAll(async () => {
  for (const s of [...live]) await stop(s)
  for (const d of [STATIC.dist, LOADER.dist, ISLAND.dist, FORCED, STRAY, NOPOOL]) rmSync(join(app, d), { recursive: true, force: true })
})

test('the build says which apps need workers', () => {
  expect(manifestOf(STATIC.dist).needs_workers).toBe(false)
  expect(manifestOf(LOADER.dist).needs_workers).toBe(true)
  expect(manifestOf(ISLAND.dist).needs_workers).toBe(true) // F172: an island's server render is a worker call
})

test('an all-static app starts with no worker and serves every page as the same build with a pool does', async () => {
  // the same dist without the bit: a manifest from before F165, which must keep the pool
  variant(STATIC.dist, FORCED, (m) => delete m.needs_workers)
  const [idle, pooled] = await Promise.all([start(STATIC.dist, STATIC.entry), start(FORCED, STATIC.entry)])
  try {
    expect(idle.log()).toContain('[brust] ready (0 workers)')
    expect(pooled.log()).toContain('[brust] ready (2 workers)')
    for (const path of [...PAGES, '/_brust/cache/stats']) {
      const [a, b] = await Promise.all([snapshot(idle.base, path), snapshot(pooled.base, path)])
      expect({ path, ...a }).toEqual({ path, ...b })
    }
    expect((await snapshot(idle.base, '/')).status).toBe(200)
    expect((await snapshot(idle.base, '/count')).body).toContain('clicked')
    expect((await snapshot(idle.base, '/missing')).status).toBe(404)
  } finally {
    await Promise.all([stop(idle), stop(pooled)])
  }
}, 60_000)

test('with no worker, SIGTERM drains and exits 0 at once', async () => {
  const s = await start(STATIC.dist, STATIC.entry)
  live.delete(s)
  const t0 = performance.now()
  s.proc.kill('SIGTERM')
  const code = await Promise.race([s.proc.exited, Bun.sleep(5000).then(() => 'timeout')])
  if (code === 'timeout') s.proc.kill('SIGKILL')
  expect(code).toBe(0)
  expect(performance.now() - t0).toBeLessThan(2000)
}, 30_000)

test('--target static renders an all-static app with no worker, byte for byte as `brust start` serves it', async () => {
  const dist = '.rows/dist-idle-workers-ssg'
  try {
    const b = Bun.spawnSync([bin, 'build', STATIC.entry, '--out-dir', dist, '--target', 'static'], {
      cwd: app,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, BRUST_PORT: '', BRUST_ADDR: '', BRUST_WORKERS: '' },
    })
    if (b.exitCode !== 0) throw new Error(`brust build --target static failed:\n${b.stderr.toString()}`)
    expect(manifestOf(dist).needs_workers).toBe(false)
    const s = await start(STATIC.dist, STATIC.entry)
    try {
      for (const [path, file] of [['/', 'index.html'], ['/about', 'about.html'], ['/count', 'count.html']] as const)
        expect({ path, html: readFileSync(join(app, dist, 'static', file), 'utf8') }).toEqual({ path, html: (await snapshot(s.base, path)).body })
    } finally {
      await stop(s)
    }
  } finally {
    rmSync(join(app, dist), { recursive: true, force: true })
  }
}, 120_000)

test('one route with a loader keeps the whole pool', async () => {
  const s = await start(LOADER.dist, LOADER.entry)
  try {
    expect(s.log()).toContain('[brust] ready (2 workers)')
    const r = await snapshot(s.base, '/greet')
    expect(r.status).toBe(200)
    expect(r.body).toContain('Hello Ada')
  } finally {
    await stop(s)
  }
}, 60_000)

test('a worker call that reaches a server with no worker answers 503 at once, and the server keeps serving', async () => {
  // a hand-edited manifest claims no route needs a worker while one has a loader
  variant(LOADER.dist, STRAY, (m) => {
    m.needs_workers = false
  })
  const s = await start(STRAY, LOADER.entry)
  try {
    expect(s.log()).toContain('[brust] ready (0 workers)')
    const t0 = performance.now()
    const r = await snapshot(s.base, '/greet')
    expect(r.status).toBe(503)
    expect(r.body).not.toContain('Ada')
    expect(performance.now() - t0).toBeLessThan(1000)
    expect((await snapshot(s.base, '/about')).status).toBe(200)
    expect(s.proc.exitCode).toBeNull()
  } finally {
    await stop(s)
  }
}, 60_000)

test('F172: an all-static app with one island keeps needs_workers, starts the pool and renders the island on the server', async () => {
  const s = await start(ISLAND.dist, ISLAND.entry)
  try {
    expect(s.log()).toContain('[brust] ready (2 workers)')
    const page = await snapshot(s.base, '/island')
    expect(page.status).toBe(200)
    expect(page.body).toContain('Static markup around one island.')
    expect(page.body).toContain('<brust-island') // the island shell
    expect(page.body).toContain('pressed') // the island's own server-rendered text
    // the pages around it are as static as ever
    expect((await snapshot(s.base, '/about')).status).toBe(200)
  } finally {
    await stop(s)
  }
}, 60_000)

test('F172: the island page is a worker call: with the pool taken away (a hand-edited manifest) it answers 503, not a half page', async () => {
  variant(ISLAND.dist, NOPOOL, (m) => {
    m.needs_workers = false
  })
  const s = await start(NOPOOL, ISLAND.entry)
  try {
    expect(s.log()).toContain('[brust] ready (0 workers)')
    const r = await snapshot(s.base, '/island')
    expect(r.status).toBe(503)
    expect(r.body).not.toContain('pressed')
    expect((await snapshot(s.base, '/about')).status).toBe(200)
  } finally {
    await stop(s)
  }
}, 60_000)
