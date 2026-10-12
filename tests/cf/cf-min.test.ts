// M4-CF-3 e2e: cf-min built for Cloudflare, served by local workerd (`wrangler dev`), probed over HTTP.
// Opt-in: BRUST_CF_E2E=1 (it builds the wasm host and runs wrangler — minutes, not seconds).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { WRANGLER } from './tools'

const ENABLED = process.env.BRUST_CF_E2E === '1'
const APP = resolve(import.meta.dir, '../fixtures/cf-min')
const CF = join(APP, 'dist/cf')
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

const get = (path: string, init?: RequestInit) => fetch(base + path, { redirect: 'manual', ...init })
const S = async () => (await (await get('/_brust/cache/stats')).json()) as { loader_calls: number; job_calls: number }
const bump = (body: string, headers: Record<string, string> = {}) =>
  get('/_brust/action/bump', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  })

describe.skipIf(!ENABLED)('cf-min on local workerd', () => {
  beforeAll(async () => {
    mkdirSync(OUT, { recursive: true })
    const build = Bun.spawnSync(['bun', join(APP, 'scripts/build-cf.ts')], { cwd: APP, stdout: 'inherit', stderr: 'inherit' })
    if (build.exitCode !== 0) throw new Error(`build-cf exited ${build.exitCode}`)

    const dry = Bun.spawnSync(
      ['bunx', WRANGLER, 'deploy', '--dry-run', '--outdir', join(OUT, 'bundle'), '-c', join(CF, 'wrangler.jsonc')],
      { cwd: CF, env: ENV },
    )
    const dryOut = dry.stdout.toString() + dry.stderr.toString()
    writeFileSync(join(OUT, 'dry-run.txt'), dryOut)
    if (dry.exitCode !== 0) throw new Error(`wrangler deploy --dry-run exited ${dry.exitCode}:\n${dryOut}`)
    console.log(dryOut.match(/Total Upload:.*/)?.[0] ?? 'no Total Upload line')

    const [port, inspector] = [await freePort(), await freePort()]
    dev = Bun.spawn(
      [
        'bunx',
        WRANGLER,
        'dev',
        '--port',
        String(port),
        '--ip',
        '127.0.0.1',
        '--inspector-port',
        String(inspector),
        '--persist-to',
        join(OUT, 'state'),
        '--show-interactive-dev-session=false',
      ],
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
    writeFileSync(join(OUT, 'wrangler-dev.log'), log)
    if (!dev) return
    dev.kill('SIGINT')
    const killed = await Promise.race([dev.exited.then(() => true), Bun.sleep(5000).then(() => false)])
    if (!killed) dev.kill('SIGKILL')
    await dev.exited
    expect(await get('/').then(() => 'open', () => 'refused')).toBe('refused')
  })

  test('1 GET / is the static page, no loader', async () => {
    const r = await get('/')
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('text/html')
    expect(await r.text()).toContain('cf-min home')
    // The real build's generator (`brust/<version>`), not the D3 snapshot's `brust/cf-e2e`.
    expect(r.headers.get('x-powered-by')).toStartWith('brust/')
    expect((await S()).loader_calls).toBe(0)
  })

  test('2 GET /items/7 runs the loader and the job once, then hits L1', async () => {
    const a = await get('/items/7')
    expect(a.status).toBe(200)
    expect(a.headers.get('x-brust-cache')).toBe('MISS')
    expect(await a.text()).toContain('$7.00')
    const b = await get('/items/7')
    expect(b.headers.get('x-brust-cache')).toBe('HIT')
    await b.text()
    const s = await S()
    expect(s.loader_calls).toBe(1)
    expect(s.job_calls).toBe(1)
  })

  test('3 GET /island SSRs the React island and links its client chunk', async () => {
    const r = await get('/island')
    expect(r.status).toBe(200)
    const html = await r.text()
    expect(html).toMatch(/<brust-island[^>]*><button[^>]*>count <!-- -->3<\/button>/)
    expect(html).toMatch(/<script[^>]*src="\/_brust\/client\/react-counter_[^"]+\.js"/)
    expect((await S()).job_calls).toBe(2)
  })

  test('4 HEAD /items/7 is 200 with an empty body', async () => {
    const r = await get('/items/7', { method: 'HEAD' })
    expect(r.status).toBe(200)
    expect(await r.text()).toBe('')
  })

  test('5 GET action hello passes through Elysia with CORS', async () => {
    const r = await get('/_brust/action/hello', { headers: { origin: 'https://ok.example' } })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ hello: 'cf' })
    expect(r.headers.get('access-control-allow-origin')).toBe('https://ok.example')
    expect(r.headers.get('x-powered-by')).toBeTruthy()
  })

  test('6 POST action bump invalidates the items tag', async () => {
    const r = await bump('{"tag":"items"}')
    expect(r.status).toBe(200)
    expect(((await r.json()) as { l1Removed: number }).l1Removed).toBeGreaterThanOrEqual(1)
    const again = await get('/items/7')
    expect(again.headers.get('x-brust-cache')).toBe('MISS')
    await again.text()
    expect((await S()).loader_calls).toBe(2)
  })

  test('7 POST bump with an invalid body is 422', async () => {
    const r = await bump('{}')
    expect(r.status).toBe(422)
    await r.text()
  })

  test('8 POST bump from a foreign origin is rejected', async () => {
    const r = await bump('{"tag":"items"}', { origin: 'https://evil.example' })
    expect(r.status).toBe(403)
    expect(r.headers.get('content-type')).toContain('application/problem+json')
    expect(((await r.json()) as { title: string }).title).toBe('CrossSiteRejected')
  })

  test('9 body limits: 2048 bytes is 413, gzip is 415', async () => {
    const big = await bump(JSON.stringify({ tag: 'x'.repeat(2048 - 10) }))
    expect(big.status).toBe(413)
    await big.text()
    const gz = await bump('{"tag":"items"}', { 'content-encoding': 'gzip' })
    expect(gz.status).toBe(415)
    await gz.text()
  })

  test('10 OPTIONS preflight is 204 with ACAO', async () => {
    const r = await get('/items/7', {
      method: 'OPTIONS',
      headers: { origin: 'https://ok.example', 'access-control-request-method': 'GET' },
    })
    expect(r.status).toBe(204)
    expect(r.headers.get('access-control-allow-origin')).toBe('https://ok.example')
  })

  test('11 static assets come from ASSETS; misses fall through to the worker', async () => {
    const manifest = JSON.parse(readFileSync(join(APP, 'dist/manifest.json'), 'utf8'))
    const runtime = (manifest.assets.runtime as string).replace(/^client\//, '')
    const asset = await get(`/_brust/client/${runtime}`)
    expect(asset.status).toBe(200)
    await asset.text()
    // Served by ASSETS, not the worker: no x-brust-cache, the _headers immutable policy.
    expect(asset.headers.get('x-brust-cache')).toBeNull()
    expect(asset.headers.get('cache-control')).toContain('immutable')
    const nope = await get('/_brust/client/nope.js')
    expect(nope.status).toBe(404)
    expect(await nope.text()).toBe('not found')
    expect(nope.headers.get('x-powered-by')).toBeTruthy()
    const css = await get('/public/app.css')
    expect(css.status).toBe(200)
    await css.text()
    const miss = await get('/public/nope.txt')
    expect(miss.status).toBe(404)
    await miss.text()
  })

  test('12 a panic is a 500 and the isolate keeps serving', async () => {
    const r = await get('/__brust_e2e/panic', { signal: AbortSignal.timeout(10_000) })
    expect(r.status).toBe(500)
    await r.text()
    const deadline = Date.now() + 5000
    while (!log.includes('panicked at') && Date.now() < deadline) await Bun.sleep(100)
    expect(log).toContain('panicked at')
    expect((await get('/')).status).toBe(200)
    const item = await get('/items/7')
    expect(item.headers.get('x-brust-cache')).toBe('HIT')
    await item.text()
  })

  test('13 index_bg.wasm is under 4 MiB', () => {
    expect(statSync(join(CF, 'worker/index_bg.wasm')).size).toBeLessThan(4 * 1024 * 1024)
  })

  test('14 dangerouslySetInnerHTML renders raw markup; null is empty, a number is its string; {text} stays escaped', async () => {
    const raw = async (kind: string) => {
      const r = await get(`/raw/${kind}`)
      expect(r.status).toBe(200)
      return r.text()
    }
    const html = await raw('html')
    expect(html).toContain('<div id="raw"><b>x</b></div>')
    expect(html).toContain('<p id="text">&lt;b&gt;x&lt;/b&gt;</p>')
    expect(await raw('null')).toContain('<div id="raw"></div>')
    expect(await raw('num')).toContain('<div id="raw">7</div>')
  })

  test('p50 of 50 distinct-id MISSes', async () => {
    const ms: number[] = []
    for (let i = 0; i < 50; i++) {
      const t0 = performance.now()
      const r = await get(`/items/${1000 + i}`)
      await r.text()
      ms.push(performance.now() - t0)
      expect(r.headers.get('x-brust-cache')).toBe('MISS')
    }
    ms.sort((a, b) => a - b)
    const line = `cf-min local workerd: p50 MISS ${ms[25].toFixed(2)} ms (n=50, min ${ms[0].toFixed(2)}, max ${ms[49].toFixed(2)})\n`
    writeFileSync(join(OUT, 'latency.txt'), line)
    console.log(line.trim())
  })
})
