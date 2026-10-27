// Loader response headers (F464, design 2026-10-26-loader-headers) against packages/brust/test/fixtures/loader-headers
// served by `brust start`: what the Assets Art console needs (B-3). (1) a redirect carries two Set-Cookie, (2) a
// layout's `no-store` reaches every page under it, the server cache does not store them and the SPA page cache does not
// keep them (two navigations = two fetches, in Chromium), (3) Referrer-Policy + no-store on a redirect, (4) a CSP header.
// Run alone: `bun test --timeout 300000 tests/server/loader-headers.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/loader-headers')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
let proc: ReturnType<typeof Bun.spawn>
let base = ''
let log = ''
let browser: Browser

beforeAll(async () => {
  rmSync(join(app, 'dist'), { recursive: true, force: true })
  const env = { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '', NODE_ENV: 'production' }
  const b = Bun.spawnSync([bin, 'build', 'routes.tsx'], { cwd: app, env, stdout: 'pipe', stderr: 'pipe' })
  if (b.exitCode !== 0) throw new Error(`brust build failed:\n${b.stderr.toString()}`)
  proc = Bun.spawn([bin, 'start', '--port', '0', '--workers', '1'], { cwd: app, env, stdout: 'pipe', stderr: 'pipe' })
  const dec = new TextDecoder()
  void (async () => { for await (const c of proc.stderr as ReadableStream<Uint8Array>) log += dec.decode(c) })()
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  let out = ''
  while (!/\[brust\] ready/.test(out) || !/listening on (\S+)/.test(out)) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`brust start exited before ready:\n${out}\n${log}`)
    out += dec.decode(value, { stream: true })
  }
  base = `http://${/listening on (\S+)/.exec(out)![1]}`
  void (async () => { for (;;) { const { done, value } = await reader.read(); if (done) return; log += dec.decode(value) } })()
  browser = await chromium.launch()
}, 240_000)

afterAll(async () => {
  await browser?.close()
  proc?.kill('SIGINT')
  if ((await Promise.race([proc?.exited, Bun.sleep(5000).then(() => undefined)])) === undefined) { proc.kill('SIGKILL'); await proc.exited }
  rmSync(join(app, 'dist'), { recursive: true, force: true })
})

const get = (path: string) => fetch(base + path, { redirect: 'manual' })

test('(1)+(3) a redirect carries both Set-Cookie, Referrer-Policy and no-store; Location is redirect()\'s', async () => {
  const r = await get('/logout')
  expect(r.status).toBe(303)
  expect(r.headers.get('location')).toBe('/')
  expect(r.headers.getSetCookie()).toEqual(['a=1; Path=/; SameSite=Lax', 'b=2; Path=/; SameSite=Lax'])
  expect(r.headers.get('referrer-policy')).toBe('no-referrer')
  expect(r.headers.get('cache-control')).toBe('no-store')
})

test('(2) a layout\'s no-store reaches every page under it, and the server cache does not store them', async () => {
  for (const p of ['/private/one', '/private/two']) {
    const seen: (string | null)[] = []
    for (let i = 0; i < 2; i++) {
      const r = await get(p)
      expect(r.status).toBe(200)
      expect(r.headers.get('cache-control')).toBe('no-store')
      seen.push(r.headers.get('x-brust-cache'))
      await r.text()
    }
    expect(seen).toEqual(['MISS', 'MISS'])
  }
  // the control: the same cache config without it is stored
  const hits: (string | null)[] = []
  for (let i = 0; i < 2; i++) hits.push((await get('/public')).headers.get('x-brust-cache'))
  expect(hits).toEqual(['MISS', 'HIT'])
  // a Set-Cookie page on a cached route is not stored either
  const c: (string | null)[] = []
  for (let i = 0; i < 2; i++) {
    const r = await get('/cookie')
    expect(r.headers.getSetCookie()).toEqual(['seen=1; Path=/'])
    c.push(r.headers.get('x-brust-cache'))
  }
  expect(c).toEqual(['MISS', 'MISS'])
})

test('F467: a cached page whose loader sends Vary: Cookie is not stored; Vary: Accept-Encoding is', async () => {
  const seen = async (path: string) => {
    const out: (string | null)[] = []
    for (let i = 0; i < 2; i++) {
      const r = await get(path)
      expect(r.status).toBe(200)
      out.push(r.headers.get('x-brust-cache'))
      await r.text()
    }
    return out
  }
  expect(await seen('/vary-cookie')).toEqual(['MISS', 'MISS'])
  expect((await get('/vary-cookie')).headers.get('vary')?.toLowerCase()).toContain('cookie')
  expect(await seen('/vary-encoding')).toEqual(['MISS', 'HIT'])
})

test('F466: httpError answers with its content type, the chain\'s headers and its own; a refused name in its options is dropped', async () => {
  const j = await get('/err-json')
  expect(j.status).toBe(401)
  expect(j.headers.get('content-type')).toBe('application/json; charset=utf-8')
  expect(j.headers.get('x-chain')).toBe('kept')
  expect(j.headers.get('x-why')).toBe('expired')
  expect(await j.json()).toEqual({ error: 'unauthorized' })
  const h = await get('/err-html')
  expect(h.status).toBe(400)
  expect(h.headers.get('content-type')).toBe('text/html; charset=utf-8')
  expect(await h.text()).toBe('<b>no</b>')
})

test('(4) a Content-Security-Policy set by a loader arrives as a header', async () => {
  const r = await get('/csp')
  expect(r.status).toBe(200)
  expect(r.headers.get('content-security-policy')).toBe("frame-ancestors 'none'")
})

test('a server-owned name is dropped in production with a warning naming it; the rest arrive', async () => {
  const r = await get('/refused')
  expect(r.status).toBe(200)
  expect(r.headers.get('location')).toBeNull()
  expect(r.headers.get('x-ok')).toBe('1')
  expect(r.headers.get('content-type')).toBe('text/html; charset=utf-8')
  await Bun.sleep(100)
  expect(log).toContain('"Location"')
})

test('SPA: a no-store page is fetched on every navigation, a cacheable one once; a redirect sets both cookies', async () => {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  const fetched: string[] = []
  page.on('request', (r) => { if (r.resourceType() === 'fetch') fetched.push(new URL(r.url()).pathname) })
  await page.goto(`${base}/`)
  const go = (u: string) => page.evaluate(async (u) => {
    await (globalThis as unknown as Record<symbol, { navigate(u: string): Promise<void> }>)[Symbol.for('brust.nav')]!.navigate(u)
  }, u)
  for (const u of ['/private/one', '/public', '/private/one', '/public']) {
    await go(u)
    expect(await page.locator('article').getAttribute('data-page')).toBe(u === '/public' ? 'public' : 'private-one')
  }
  expect(fetched.filter((p) => p === '/private/one').length).toBe(2)
  expect(fetched.filter((p) => p === '/public').length).toBe(1)
  // the fetch follows the 303; the browser stores both cookies on the way
  await go('/logout')
  expect(new URL(page.url()).pathname).toBe('/')
  expect((await ctx.cookies()).map((c) => `${c.name}=${c.value}`).sort()).toEqual(['a=1', 'b=2'])
  await ctx.close()
})
