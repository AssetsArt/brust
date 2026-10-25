// F461 (design docs/design/2026-10-25-spa-navigation-design.md §11): the built-in `navigation` store, read through
// `useStore(navigation)` by a native component and by React islands, in real Chromium against
// packages/brust/test/fixtures/nav-store, served by `brust start` and as `--target static` files.
// Run alone: `bun test --timeout 300000 tests/server/nav-store.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium, type Page } from 'playwright'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/nav-store')
const bin = join(import.meta.dir, '../../packages/brust/bin/brust')
const out = join(app, 'dist/static')
let proc: ReturnType<typeof Bun.spawn>
let base = ''
let staticServer: ReturnType<typeof Bun.serve> | undefined
let staticBase = ''
let browser: Browser

beforeAll(async () => {
  rmSync(join(app, 'dist'), { recursive: true, force: true })
  const env = { ...process.env, BRUST_PORT: '', BRUST_WORKERS: '', BRUST_ADDR: '', NODE_ENV: 'production' }
  for (const args of [['build', 'routes.tsx'], ['build', 'routes.tsx', '--target', 'static']]) {
    const b = Bun.spawnSync([bin, ...args], { cwd: app, env, stdout: 'pipe', stderr: 'pipe' })
    if (b.exitCode !== 0) throw new Error(`brust ${args.join(' ')} failed:\n${b.stderr.toString()}`)
  }
  proc = Bun.spawn([bin, 'start', '--port', '0', '--workers', '1'], { cwd: app, env, stdout: 'pipe', stderr: 'inherit' })
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  let log = ''
  while (!/\[brust\] ready/.test(log) || !/listening on (\S+)/.test(log)) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`brust start exited before ready:\n${log}`)
    log += dec.decode(value, { stream: true })
  }
  base = `http://${/listening on (\S+)/.exec(log)![1]}`
  void (async () => { for (;;) { const { done } = await reader.read(); if (done) return } })()
  // the static files served the way Cloudflare Pages does (a path answers its file or <path>.html, else 404.html)
  staticServer = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, '')
      if (rel === 'slow' || rel === 'slow.html') await Bun.sleep(700) // a slow page, like the served app's loader
      for (const f of [rel, `${rel}.html`, rel === '' ? 'index.html' : null]) {
        if (f === null || f.includes('..')) continue
        const p = join(out, f)
        if (existsSync(p) && statSync(p).isFile()) return new Response(Bun.file(p))
      }
      return new Response(Bun.file(join(out, '404.html')), { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } })
    },
  })
  staticBase = `http://127.0.0.1:${staticServer.port}`
  browser = await chromium.launch()
}, 240_000)

afterAll(async () => {
  await browser?.close()
  await staticServer?.stop(true)
  proc?.kill('SIGINT')
  if ((await Promise.race([proc?.exited, Bun.sleep(5000).then(() => undefined)])) === undefined) { proc.kill('SIGKILL'); await proc.exited }
  rmSync(join(app, 'dist'), { recursive: true, force: true })
})

/** The text of the store readers on screen: the native one and the layout island. */
const readers = (page: Page) =>
  page.evaluate(() => {
    const t = (sel: string) => document.querySelector(sel)?.textContent?.trim() ?? null
    return { native: t('[data-nav="native"]'), layout: t('[data-nav="island-layout"]'), page: t('[data-nav="island-page"]') }
  })

async function open(path: string, root = base) {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 600 } })
  const page = await ctx.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type()) && !m.text().startsWith('Failed to load resource')) errors.push(`${m.type()}: ${m.text()}`) })
  await page.goto(root + path)
  await settle(page)
  return { page, errors, close: () => ctx.close() }
}

/** Settled: no navigation loading, every island hydrated, the store reader mounted. */
const settle = (page: Page) =>
  page.waitForFunction(() => !document.documentElement.hasAttribute('data-brust-loading') && !document.querySelector('brust-island:not([data-hydrated])') && document.querySelector('[data-nav="native"][x-data]'))

/** The raw server HTML of `path` (no JavaScript ran): the first paint. */
const rawHtml = async (root: string, path: string) => (await fetch(root + path)).text()
const paint = (html: string, nav: string) =>
  new RegExp(`<p [^>]*data-nav="${nav}"[^>]*>(.*?)</p>`).exec(html)?.[1]?.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&') ?? null

for (const [mode, root] of [['served', () => base], ['static', () => staticBase]] as const) {
  const q = mode === 'served' ? '?a=1&b=two' : ''

  test(`${mode}: the first paint says idle and the request path, in the native reader and the island`, async () => {
    const html = await rawHtml(root(), `/other${q}`)
    expect(paint(html, 'native')).toBe(`idle | /other${q} | - | - | - | -`)
    expect(paint(html, 'island-layout')).toBe(`idle | /other${q} | -`)
    const island = await rawHtml(root(), '/island')
    expect(paint(island, 'island-page')).toBe('idle | /island | -')
    // The server wrote the snapshot the islands hydrate against.
    expect(html).toMatch(/data-brust-store="navigation"/)
  })

  test(`${mode}: a full load hydrates without a mismatch or a console error`, async () => {
    for (const path of [`/other${q}`, '/island']) {
      const { page, errors, close } = await open(path, root())
      expect(errors).toEqual([])
      const r = await readers(page)
      const want = path.startsWith('/island') ? '/island' : `/other${q}`
      expect(r.native).toBe(`idle | ${want} | - | - | - | -`)
      expect(r.layout).toBe(`idle | ${want} | -`)
      if (path === '/island') expect(r.page).toBe('idle | /island | -')
      await close()
    }
  })

  test(`${mode}: while a navigation loads, state is loading and to is set; after it, idle with the new url`, async () => {
    const { page, errors, close } = await open('/', root())
    await page.click('nav a[href="/slow"]')
    await page.waitForFunction(() => document.querySelector('[data-nav="native"]')?.getAttribute('data-state') === 'loading')
    const during = await readers(page)
    expect(during.native).toBe('loading | / | /slow | - | - | link')
    expect(during.layout).toBe('loading | / | /slow')
    await page.waitForFunction(() => document.querySelector('[data-nav="native"]')?.getAttribute('data-state') === 'idle')
    await settle(page)
    const after = await readers(page)
    expect(after.native).toBe('idle | /slow | - | - | 200 | link')
    expect(after.layout).toBe('idle | /slow | -')
    expect(errors).toEqual([])
    await close()
  })

  test(`${mode}: an island on a page navigated to hydrates against that page's snapshot`, async () => {
    const { page, errors, close } = await open('/', root())
    await page.click('nav a[href="/island"]')
    await page.waitForSelector('[data-nav="island-page"]')
    await page.waitForFunction(() => document.querySelector('[data-nav="island-page"]')?.closest('brust-island')?.hasAttribute('data-hydrated'))
    const r = await readers(page)
    expect(r.page).toBe('idle | /island | -')
    expect(r.native).toBe('idle | /island | - | - | 200 | link')
    expect(errors).toEqual([])
    expect(await page.evaluate(() => performance.getEntriesByType('navigation').length)).toBe(1)
    await close()
  })

  test(`${mode}: a swapped 404 sets url and error, and the next load clears error`, async () => {
    const { page, errors, close } = await open('/', root())
    await page.click('nav a[href="/missing"]')
    await page.waitForFunction(() => document.querySelector('[data-page="missing"]'))
    await settle(page)
    expect((await readers(page)).native).toBe('idle | /missing | - | HTTP 404 | 404 | link')
    await page.click('nav a[href="/other"]')
    await page.waitForFunction(() => document.querySelector('[data-page="other"]'))
    await settle(page)
    expect((await readers(page)).native).toBe('idle | /other | - | - | 200 | link')
    expect(errors).toEqual([])
    await close()
  })
}

test('a network failure sets error and leaves the page on screen when the app cancels the full load', async () => {
  const { page, close } = await open('/', base)
  await page.evaluate(() => document.addEventListener('brust:nav:error', (e) => e.preventDefault()))
  await page.route('**/other', (r) => r.abort())
  await page.click('nav a[href="/other"]')
  await page.waitForFunction(() => document.querySelector('[data-nav="native"]')?.textContent?.includes('Failed to fetch'))
  const r = await readers(page)
  expect(r.native).toBe('idle | / | - | Failed to fetch | - | link')
  expect(await page.evaluate(() => document.querySelector('[data-page]')?.getAttribute('data-page'))).toBe('home')
  await close()
})

test('it is a normal store: a plain script reads it, and a write is overwritten by the next navigation event', async () => {
  const { page, close } = await open('/', base)
  const seen = await page.evaluate(async () => {
    const reg = (globalThis as unknown as Record<symbol, Record<string, { instance: Record<string, { (): unknown; set(v: unknown): void }> }>>)[Symbol.for('brust.stores')]!
    const nav = reg.navigation!.instance
    const first = [nav.state!(), nav.url!(), nav.id!()]
    nav.url!.set('/written')
    const written = nav.url!()
    document.querySelector<HTMLAnchorElement>('nav a[href="/other"]')!.click()
    await new Promise((r) => setTimeout(r, 600))
    return { first, written, url: nav.url!(), id: nav.id!() }
  })
  expect(seen.first).toEqual(['idle', '/', 0])
  expect(seen.written).toBe('/written')
  expect(seen.url).toBe('/other')
  expect(seen.id).toBeGreaterThan(0)
  await close()
})
