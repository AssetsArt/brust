// L12 e2e: the `--target static` + `[actions]` output served by `wrangler pages dev` (local workerd, the
// Pages advanced-mode runtime): pages are static files that never reach the Worker (`_routes.json`), the
// action prefix is answered by `_worker.js` (admission and the cross-site guard in Rust), and anything else
// that does reach the Worker falls through to ASSETS. Opt-in: BRUST_CF_E2E=1 (a wasm host + wrangler).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { WRANGLER } from './tools'

const ENABLED = process.env.BRUST_CF_E2E === '1'
const REPO = resolve(import.meta.dir, '../..')
const APP = join(REPO, 'packages/brust/test/fixtures/static-actions')
const DIST = join(APP, 'dist')
const OUT = process.env.BRUST_CF_OUT ?? '/tmp/m4cf-worker-crate'
const ENV = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }

const freePort = () =>
  new Promise<number>((ok, fail) => {
    const s = createServer()
    s.once('error', fail)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => ok(port))
    })
  })

let base = ''
let dev: ReturnType<typeof Bun.spawn> | undefined
let log = ''
const calls = async () => ((await (await get('/api/__calls')).json()) as { n: number }).n
const get = (path: string, init?: RequestInit) => fetch(base + path, { redirect: 'manual', ...init })

describe.skipIf(!ENABLED)('static pages + actions on wrangler pages dev', () => {
  beforeAll(async () => {
    mkdirSync(OUT, { recursive: true })
    const core = join(REPO, 'npm/core-cf')
    if (!existsSync(join(core, 'worker/index.js'))) {
      const w = Bun.spawnSync(['bun', join(REPO, 'crates/brust-wasm/scripts/build.ts')], { cwd: REPO, stdout: 'inherit', stderr: 'inherit' })
      if (w.exitCode !== 0) throw new Error(`core-cf build exited ${w.exitCode}`)
    }
    rmSync(DIST, { recursive: true, force: true })
    const b = Bun.spawnSync([process.execPath, join(REPO, 'packages/brust/src/cli.ts'), 'build', 'routes.tsx', '--target', 'static'], {
      cwd: APP,
      env: { ...process.env, BRUST_CORE_CF_DIR: core, BRUST_PORT: '', BRUST_ADDR: '' },
      stdout: 'inherit',
      stderr: 'inherit',
    })
    if (b.exitCode !== 0) throw new Error(`brust build --target static exited ${b.exitCode}`)

    // The served tree is a copy whose Worker counts its invocations (`/api/__calls`, under the included prefix),
    // so "pages never reach the Worker" is observed, not assumed. The real worker is `real.js`, untouched.
    const served = join(DIST, 'counted')
    cpSync(join(DIST, 'static'), served, { recursive: true })
    renameSync(join(served, '_worker.js/index.js'), join(served, '_worker.js/real.js'))
    writeFileSync(
      join(served, '_worker.js/index.js'),
      "import W from './real.js'\nlet n = 0\nexport default { fetch(req, env, ctx) { if (new URL(req.url).pathname === '/api/__calls') return Response.json({ n }); n++; return W.fetch(req, env, ctx) } }\n",
    )
    const cfg = Bun.JSONC.parse(readFileSync(join(DIST, 'wrangler.jsonc'), 'utf8')) as { compatibility_date: string }
    const [port, inspector] = [await freePort(), await freePort()]
    dev = Bun.spawn(
      [
        'bunx',
        WRANGLER,
        'pages',
        'dev',
        served,
        '--port',
        String(port),
        '--ip',
        '127.0.0.1',
        '--inspector-port',
        String(inspector),
        '--compatibility-date',
        cfg.compatibility_date,
        '--persist-to',
        join(OUT, 'pages-state'),
        '--show-interactive-dev-session=false',
      ],
      { cwd: DIST, env: ENV, stdout: 'pipe', stderr: 'pipe' },
    )
    const pump = async (s: ReadableStream<Uint8Array>) => {
      const d = new TextDecoder()
      for await (const chunk of s) log += d.decode(chunk)
    }
    void pump(dev.stdout as ReadableStream<Uint8Array>)
    void pump(dev.stderr as ReadableStream<Uint8Array>)
    const deadline = Date.now() + 120_000
    while (!/Ready on/.test(log)) {
      if (Date.now() > deadline || dev.exitCode !== null) throw new Error(`wrangler pages dev not ready:\n${log}`)
      await Bun.sleep(250)
    }
    base = `http://127.0.0.1:${port}`
  })

  afterAll(async () => {
    writeFileSync(join(OUT, 'pages-dev.log'), log)
    if (!dev) return
    dev.kill('SIGINT')
    const killed = await Promise.race([dev.exited.then(() => true), Bun.sleep(5000).then(() => false)])
    if (!killed) dev.kill('SIGKILL')
    await dev.exited
  })

  test('1 pages are static files: _routes.json keeps them off the Worker (invocation counter)', async () => {
    const routes = JSON.parse(readFileSync(join(DIST, 'static/_routes.json'), 'utf8')) as { include: string[] }
    expect(routes.include).toEqual(['/api', '/api/*'])
    for (const [path, text] of [
      ['/', 'static actions home'],
      ['/about', 'static actions home'],
    ] as const) {
      const r = await get(path)
      expect(r.status).toBe(200)
      expect(await r.text()).toContain(text)
    }
    expect((await get('/nope')).status).toBe(404)
    expect(await calls()).toBe(0)
  })

  test('2 an unknown path is the 404 page with status 404', async () => {
    const r = await get('/nope')
    expect(r.status).toBe(404)
    expect(await r.text()).toContain('Not found')
  })

  test('3 GET an action is answered by the Worker', async () => {
    const r = await get('/api/hello')
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ hello: 'pages' })
    expect(r.headers.get('x-powered-by')).toStartWith('brust/')
    expect(await calls()).toBe(1)
  })

  test('4 POST an action with a same-site origin echoes; a cross-site origin is 403', async () => {
    const headers = { 'content-type': 'application/json' }
    const ok = await get('/api/echo', { method: 'POST', headers: { ...headers, origin: base }, body: JSON.stringify({ msg: 'hi' }) })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ echo: 'hi' })
    const cross = await get('/api/echo', { method: 'POST', headers: { ...headers, origin: 'https://evil.example' }, body: JSON.stringify({ msg: 'hi' }) })
    expect(cross.status).toBe(403)
  })

  test('5 an unknown action path is the Worker 404, not a page', async () => {
    const r = await get('/api/missing')
    expect(r.status).toBe(404)
    expect(r.headers.get('x-powered-by')).toStartWith('brust/')
  })
})
