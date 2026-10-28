// L16 e2e (R16.5, CF): `brust build --actions-only --target cloudflare` served by local workerd (`wrangler dev`): a
// Worker with only actions (root prefix, no Static Assets). An action answers, a page path is a 404, the cross-site
// guard still says 403, and a listed origin passes with its CORS headers. Opt-in: BRUST_CF_E2E=1 (a wasm host + wrangler).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { WRANGLER } from './tools'

const ENABLED = process.env.BRUST_CF_E2E === '1'
const REPO = resolve(import.meta.dir, '../..')
const FIX = join(REPO, 'packages/brust/test/fixtures/standalone')
const RUN = join(FIX, '.cf-run')
const APP = join(RUN, 'api')
const CF = join(APP, 'dist/cf')
const OUT = process.env.BRUST_CF_OUT ?? '/tmp/m4cf-worker-crate'
const ENV = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }
const PAGE = 'https://app.example'

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
const get = (path: string, init?: RequestInit) => fetch(base + path, { redirect: 'manual', ...init })

describe.skipIf(!ENABLED)('actions-only Worker on wrangler dev', () => {
  beforeAll(async () => {
    mkdirSync(OUT, { recursive: true })
    const core = join(REPO, 'npm/core-cf')
    if (!existsSync(join(core, 'worker/index.js'))) {
      const w = Bun.spawnSync(['bun', join(REPO, 'crates/brust-wasm/scripts/build.ts')], { cwd: REPO, stdout: 'inherit', stderr: 'inherit' })
      if (w.exitCode !== 0) throw new Error(`core-cf build exited ${w.exitCode}`)
    }
    rmSync(RUN, { recursive: true, force: true })
    mkdirSync(RUN, { recursive: true })
    cpSync(join(FIX, 'api'), APP, { recursive: true })
    writeFileSync(join(APP, 'brust.toml'), `[actions]\nentry = "actions.ts"\nprefix = "/"\n\n[cors]\norigins = ["${PAGE}"]\ncredentials = true\n`)
    const b = Bun.spawnSync([process.execPath, join(REPO, 'packages/brust/src/cli.ts'), 'build', '--actions-only', '--target', 'cloudflare'], {
      cwd: APP,
      env: { ...process.env, BRUST_CORE_CF_DIR: core, BRUST_PORT: '', BRUST_ADDR: '' },
      stdout: 'inherit',
      stderr: 'inherit',
    })
    if (b.exitCode !== 0) throw new Error(`brust build --actions-only --target cloudflare exited ${b.exitCode}`)
    expect(existsSync(join(CF, 'assets'))).toBe(false)

    const [port, inspector] = [await freePort(), await freePort()]
    dev = Bun.spawn(
      ['bunx', WRANGLER, 'dev', '--port', String(port), '--ip', '127.0.0.1', '--inspector-port', String(inspector), '--persist-to', join(OUT, 'actions-only-state'), '--show-interactive-dev-session=false'],
      { cwd: CF, env: ENV, stdout: 'pipe', stderr: 'pipe' },
    )
    const pump = async (s: ReadableStream<Uint8Array>) => {
      const d = new TextDecoder()
      for await (const chunk of s) log += d.decode(chunk)
    }
    void pump(dev.stdout as ReadableStream<Uint8Array>)
    void pump(dev.stderr as ReadableStream<Uint8Array>)
    const deadline = Date.now() + 120_000
    while (!/Ready on/.test(log)) {
      if (Date.now() > deadline || dev.exitCode !== null) throw new Error(`wrangler dev not ready:\n${log}`)
      await Bun.sleep(250)
    }
    base = `http://127.0.0.1:${port}`
  })

  afterAll(async () => {
    writeFileSync(join(OUT, 'actions-only-dev.log'), log)
    if (dev) {
      dev.kill('SIGINT')
      const killed = await Promise.race([dev.exited.then(() => true), Bun.sleep(5000).then(() => false)])
      if (!killed) dev.kill('SIGKILL')
      await dev.exited
    }
    rmSync(RUN, { recursive: true, force: true })
  })

  test('1 the wrangler.jsonc has no assets binding', () => {
    const w = Bun.JSONC.parse(readFileSync(join(CF, 'wrangler.jsonc'), 'utf8')) as Record<string, unknown>
    expect(w.assets).toBeUndefined()
    expect(w.main).toBe('worker/index.js')
  })

  test('2 an action at the root prefix answers (GET /hello)', async () => {
    const r = await get('/hello')
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ hello: 'standalone' })
    expect(r.headers.get('x-powered-by')).toStartWith('brust/')
  })

  test('3 a page path is a 404 problem+json (there are no pages)', async () => {
    const r = await get('/nope')
    expect(r.status).toBe(404)
    expect(r.headers.get('content-type')).toContain('application/problem+json')
  })

  test('4 POST from an unlisted origin is 403 CrossSiteRejected; the listed origin passes with CORS headers', async () => {
    const headers = { 'content-type': 'application/json' }
    const body = JSON.stringify({ name: 'ash' })
    const bad = await get('/team', { method: 'POST', headers: { ...headers, origin: 'https://evil.example' }, body })
    expect(bad.status).toBe(403)
    expect(((await bad.json()) as { title: string }).title).toBe('CrossSiteRejected')
    const ok = await get('/team', { method: 'POST', headers: { ...headers, origin: PAGE }, body })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ saved: 'ash' })
    expect(ok.headers.get('access-control-allow-origin')).toBe(PAGE)
    expect(ok.headers.get('access-control-allow-credentials')).toBe('true')
  })

  test('5 the preflight answers 204', async () => {
    const r = await get('/team', { method: 'OPTIONS', headers: { origin: PAGE, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } })
    expect(r.status).toBe(204)
    expect(r.headers.get('access-control-allow-origin')).toBe(PAGE)
  })

  test('6 F474: an action sees the Content-Length the client sent, and reads the same number of bytes', async () => {
    const body = Uint8Array.from({ length: 1024 }, (_, i) => (i * 31 + 7) & 0xff)
    const r = await get('/echo', { method: 'POST', headers: { 'content-type': 'application/zip', origin: PAGE }, body })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ contentLength: '1024', bytes: 1024 })
  })
})
