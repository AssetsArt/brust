// Process lifecycle of `brust start` (run.ts): a dying worker takes the process down, a signal
// during boot exits promptly, workers run with NODE_ENV=production. Builds the fixture app into a
// gitignored dist dir and starts it with alternate worker entries (fixtures/lifecycle). Run on its own:
// `bun test --timeout 120000 test/lifecycle.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

const app = join(import.meta.dir, 'fixtures/app')
const entries = join(import.meta.dir, 'fixtures/lifecycle')
const bin = join(import.meta.dir, '../bin/brust')
let dist = ''

beforeAll(() => {
  // Inside the package (gitignored `dist/`) so jobs.js resolves `react` from node_modules.
  dist = join(entries, 'dist')
  rmSync(dist, { recursive: true, force: true })
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx', '--out-dir', dist], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}`)
}, 120_000)

afterAll(() => {
  if (dist) rmSync(dist, { recursive: true, force: true })
})

interface Started {
  proc: ReturnType<typeof Bun.spawn>
  out: () => string
  err: () => string
}

/** `brust start` on the temp dist with `entry` as the worker entry. NODE_ENV is removed from the
 * env (`bun test` sets it to "test") so run.ts's default applies. */
function start(entry: string, extraEnv: Record<string, string> = {}): Started {
  const env: Record<string, string | undefined> = {
    ...process.env,
    BRUST_PORT: '',
    BRUST_WORKERS: '',
    BRUST_ADDR: '',
    BRUST_DIST_DIR: dist,
    BRUST_APP_ENTRY: join(entries, entry),
    ...extraEnv,
  }
  delete env.NODE_ENV
  const proc = Bun.spawn([bin, 'start', '--port', '0', '--workers', '1'], { cwd: app, env, stdout: 'pipe', stderr: 'pipe' })
  let out = ''
  let err = ''
  const pump = async (s: ReadableStream<Uint8Array>, add: (t: string) => void) => {
    const dec = new TextDecoder()
    const r = s.getReader()
    for (;;) {
      const { done, value } = await r.read()
      if (done) return
      add(dec.decode(value, { stream: true }))
    }
  }
  void pump(proc.stdout as ReadableStream<Uint8Array>, (t) => {
    out += t
  })
  void pump(proc.stderr as ReadableStream<Uint8Array>, (t) => {
    err += t
  })
  return { proc, out: () => out, err: () => err }
}

async function untilReady(s: Started): Promise<string> {
  const t0 = Date.now()
  while (!/\[brust\] ready/.test(s.out())) {
    if (s.proc.exitCode !== null) throw new Error(`brust start exited before ready:\n${s.out()}\n${s.err()}`)
    if (Date.now() - t0 > 30_000) throw new Error(`not ready in 30 s:\n${s.out()}\n${s.err()}`)
    await Bun.sleep(20)
  }
  return `http://${/listening on (\S+)/.exec(s.out())![1]}`
}

/** The exit code, or `undefined` if the process is still alive after `ms` (then it is killed). */
async function exitWithin(s: Started, ms: number): Promise<number | undefined> {
  const code = await Promise.race([s.proc.exited, Bun.sleep(ms).then(() => undefined)])
  if (code === undefined) {
    s.proc.kill('SIGKILL')
    await s.proc.exited
  }
  return code
}

test('a worker that exits takes the process down non-zero (no zombie server)', async () => {
  const s = start('routes.ts')
  const base = await untilReady(s)
  expect((await fetch(`${base}/items/1`)).status).toBe(200)
  await fetch(`${base}/items/die`).catch(() => undefined) // the worker exits mid-request
  const code = await exitWithin(s, 8000)
  expect(code).toBe(1)
  expect(s.err()).toContain('[brust] worker 0 exited (code 3) — shutting down')
}, 60_000)

test('SIGTERM while the workers are still booting exits promptly', async () => {
  const s = start('slow.ts')
  const t0 = Date.now()
  while (!/listening on|server/.test(s.out()) && Date.now() - t0 < 1000) await Bun.sleep(20)
  await Bun.sleep(500) // past startServer, inside untilReady
  s.proc.kill('SIGTERM')
  const code = await exitWithin(s, 4000)
  expect(code).toBe(0)
}, 60_000)

test('a parked loader answers 504 after BRUST_CALL_TIMEOUT_MS and is counted in stats', async () => {
  const s = start('routes.ts', { BRUST_CALL_TIMEOUT_MS: '300' })
  try {
    const base = await untilReady(s)
    const r = await fetch(`${base}/items/park`)
    expect([r.status, await r.text()]).toEqual([504, 'call deadline exceeded'])
    const stats = (await (await fetch(`${base}/_brust/cache/stats`)).json()) as { timed_out_calls: number }
    expect(stats.timed_out_calls).toBe(1)
  } finally {
    s.proc.kill('SIGKILL')
    await exitWithin(s, 5000)
  }
}, 60_000)

test('BRUST_CALL_TIMEOUT_MS=0 is a config error at start', async () => {
  const s = start('routes.ts', { BRUST_CALL_TIMEOUT_MS: '0' })
  expect(await exitWithin(s, 15_000)).toBe(1)
  expect(s.err()).toContain('BRUST_CALL_TIMEOUT_MS must be an integer in 1..4294967295')
}, 60_000)

test('workers run with NODE_ENV=production by default (React production build)', async () => {
  const s = start('routes.ts')
  try {
    const base = await untilReady(s)
    const html = await (await fetch(`${base}/items/env`)).text()
    expect(html).toContain('NODE_ENV=production react-dom-server.production=true')
  } finally {
    s.proc.kill('SIGINT')
    await exitWithin(s, 5000)
  }
}, 60_000)
