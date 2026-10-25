// SPA navigation (F454, design docs/design/2026-10-25-spa-navigation-design.md §7 items 1-14) in real Chromium against
// packages/brust/test/fixtures/spa-nav, served by `brust start` and as `--target static` files. The oracle is the one
// rule (§2): after every navigation the document equals a fresh full load of the same URL (head children in order,
// <html>/<body> attributes, body DOM with counter values and persisted nodes blanked), and the document was never
// reloaded (a window marker survives). The layout matrix walks every ordered pair of its pages once (an Eulerian
// circuit of the complete digraph) and checks which layouts were kept (their counters hold a clicked value) and which
// were replaced (counters back at 0).
// Run alone: `bun test --timeout 300000 tests/server/spa-nav.chromium.test.ts`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium, type Page } from 'playwright'

const app = join(import.meta.dir, '../../packages/brust/test/fixtures/spa-nav')
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
    fetch(req) {
      const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, '')
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

type NavEvent = { type: string; id: number; url: string; trigger?: string; status?: number; swapped?: boolean; loading: boolean }
declare global { interface Window { __mark?: number; __navlog: NavEvent[] } }

/** A page that records every brust:nav:* event (with whether <html> carried data-brust-loading at that moment). */
async function open(path: string, root = base): Promise<{ page: Page; errors: string[]; close: () => Promise<void> }> {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } })
  const page = await ctx.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text()) })
  await page.addInitScript(() => {
    window.__navlog = []
    for (const t of ['click', 'load', 'success', 'error'])
      document.addEventListener(`brust:nav:${t}`, (e) => {
        const d = (e as CustomEvent).detail
        window.__navlog.push({ type: t, id: d.id, url: d.url, trigger: d.trigger, status: d.status, swapped: d.swapped, loading: document.documentElement.hasAttribute('data-brust-loading') })
      })
  })
  await page.goto(root + path)
  await settle(page)
  await page.evaluate(() => { window.__mark = 1 })
  return { page, errors, close: () => ctx.close() }
}

/** Settled: no navigation loading, every island hydrated. */
const settle = (page: Page) =>
  page.waitForFunction(() => !document.documentElement.hasAttribute('data-brust-loading') && !document.querySelector('brust-island:not([data-hydrated])'))

/** Do `act`, then wait for the navigation it starts to end (success or error). Returns that navigation's events. */
async function nav(page: Page, act: () => Promise<unknown>): Promise<NavEvent[]> {
  const n = await page.evaluate(() => window.__navlog.length)
  await act()
  await page.waitForFunction((n) => window.__navlog.slice(n).some((e) => e.type === 'success' || e.type === 'error'), n)
  await settle(page)
  return page.evaluate((n) => window.__navlog.slice(n), n)
}
const follow = (page: Page, href: string) => nav(page, () => page.click(`nav a[href="${href}"]`))

/** What a full load must equal: <html> and <body> attributes, the head children in order, the body DOM. */
const snapshot = (page: Page) =>
  page.evaluate(() => {
    const attrs = (e: Element) => [...e.attributes].map((a) => `${a.name}=${a.value}`).sort()
    const body = document.body.cloneNode(true) as HTMLElement
    body.querySelectorAll('[data-count]').forEach((e) => { e.textContent = '' })
    body.querySelectorAll('[data-brust-persist]').forEach((e) => e.replaceChildren())
    return { url: location.href, title: document.title, html: attrs(document.documentElement), body: attrs(document.body), head: [...document.head.children].map((e) => e.outerHTML), dom: body.innerHTML }
  })
const fullLoads = new Map<string, Awaited<ReturnType<typeof snapshot>>>()
async function fullLoad(url: string) {
  if (!fullLoads.has(url)) {
    const p = await open(url.replace(/^https?:\/\/[^/]+/, ''), url.match(/^https?:\/\/[^/]+/)![0])
    fullLoads.set(url, await snapshot(p.page))
    await p.close()
  }
  return fullLoads.get(url)!
}
async function expectFullLoadParity(page: Page) {
  const now = await snapshot(page)
  expect(now).toEqual(await fullLoad(now.url))
  expect(await page.evaluate(() => window.__mark)).toBe(1) // never reloaded
}

// ---- items 1, 2: a navigation equals a full load; the events and data-brust-loading ----------------------------

test('A -> B by link: no reload, head and body equal a full load, a shared stylesheet is the same node, events in order', async () => {
  const { page, errors, close } = await open('/')
  const sheets: string[] = []
  page.on('request', (r) => { if (r.url().endsWith('.css')) sheets.push(new URL(r.url()).pathname) })
  await page.evaluate(() => { (document.querySelector('link[href="/public/site.css"]') as unknown as Record<string, number>).__same = 1 })
  const ev = await follow(page, '/list')
  await expectFullLoadParity(page)
  expect(await page.title()).toBe('List')
  expect(await page.evaluate(() => [...document.querySelectorAll('link[rel=stylesheet]')].map((l) => l.getAttribute('href')))).toEqual(['/public/site.css', '/public/y.css', '/public/x.css'])
  expect(await page.evaluate(() => (document.querySelector('link[href="/public/site.css"]') as unknown as Record<string, number>).__same)).toBe(1)
  expect(sheets.filter((s) => s === '/public/site.css')).toEqual([])
  expect(ev.map((e) => [e.type, e.loading])).toEqual([['click', false], ['load', true], ['success', false]])
  expect(new Set(ev.map((e) => e.id)).size).toBe(1)
  expect(ev[2]).toMatchObject({ url: `${base}/list`, status: 200, trigger: 'link' })
  // a header with an active link (layout A's loader): B's link is the active one after the navigation
  await follow(page, '/a/one')
  await follow(page, '/a/two')
  await expectFullLoadParity(page)
  expect(await page.evaluate(() => document.querySelector('[data-layout=A] a.active')?.getAttribute('href'))).toBe('/a/two')
  expect(errors).toEqual([])
  await close()
})

// ---- item 3: a 404 page --------------------------------------------------------------------------------------

test('a 404 target is swapped in: error { status: 404, swapped: true }, no full load', async () => {
  const { page, close } = await open('/')
  const ev = await follow(page, '/missing')
  expect(ev.at(-1)).toMatchObject({ type: 'error', status: 404, swapped: true })
  await expectFullLoadParity(page)
  expect(await page.textContent('h1')).toBe('not found')
  await close()
})

// ---- item 4: network failure ------------------------------------------------------------------------------------

test('a failed fetch is error { swapped: false } and then a full load; preventDefault keeps the page', async () => {
  const { page, close } = await open('/')
  let first = true
  await page.route('**/b/one', (r) => { if (first && r.request().resourceType() === 'fetch') { first = false; return r.abort() } return r.continue() })
  const ev = await nav(page, () => page.click('nav a[href="/b/one"]'))
  expect(ev.map((e) => e.type)).toEqual(['click', 'load', 'error'])
  expect(ev[2]).toMatchObject({ swapped: false })
  await page.waitForFunction(() => window.__mark === undefined && document.querySelector('[data-page=b-one]'))
  expect(new URL(page.url()).pathname).toBe('/b/one')
  await close()

  const p2 = await open('/')
  await p2.page.route('**/b/one', (r) => r.abort())
  await p2.page.evaluate(() => document.addEventListener('brust:nav:error', (e) => e.preventDefault()))
  await nav(p2.page, () => p2.page.click('nav a[href="/b/one"]'))
  await Bun.sleep(300)
  expect(await p2.page.evaluate(() => window.__mark)).toBe(1)
  expect(new URL(p2.page.url()).pathname).toBe('/')
  await p2.close()
})

// ---- item 5: a feature module the first page did not load --------------------------------------------------------

test('B needs x-for, which A did not load: the list works after the navigation', async () => {
  const { page, errors, close } = await open('/')
  expect(await page.evaluate(() => [...document.scripts].some((s) => /rt-for/.test(s.src)))).toBe(false)
  await follow(page, '/list')
  await page.click('#add')
  await page.waitForFunction(() => document.querySelectorAll('#items li').length === 3)
  expect(errors).toEqual([])
  await close()
})

// ---- item 6: React islands ----------------------------------------------------------------------------------------

test('an island on A unmounts (its effect cleanup runs) and the island on B hydrates', async () => {
  const { page, errors, close } = await open('/island')
  await page.waitForFunction(() => (window as unknown as Record<string, number>)['mount:page-island'] === 1)
  await follow(page, '/b/one')
  expect(await page.evaluate(() => (window as unknown as Record<string, number>)['unmount:page-island'])).toBe(1)
  await page.waitForFunction(() => (window as unknown as Record<string, number>)['mount:B-island'] === 1)
  await clickUntil(page, '[data-count="B-island"]', '1')
  expect(errors).toEqual([])
  await close()
})

// ---- item 7: stores -------------------------------------------------------------------------------------------------

test('a live store keeps its client value; a store first used on B is seeded from B\'s snapshot', async () => {
  const { page, close } = await open('/store-a')
  expect(await page.textContent('#cart')).toBe('5')
  await clickUntil(page, '#cart', '6')
  await follow(page, '/store-b')
  expect(await page.textContent('#cart')).toBe('6')
  expect(await page.textContent('#late')).toBe('7')
  await close()
})

// ---- item 8: scroll ----------------------------------------------------------------------------------------------------

test('back restores the scroll position; a #hash link scrolls to its target', async () => {
  const { page, close } = await open('/long')
  await page.evaluate(() => scrollTo(0, 1500))
  await page.waitForFunction(() => scrollY === 1500)
  await follow(page, '/a/one')
  expect(await page.evaluate(() => scrollY)).toBe(0)
  const back = await nav(page, () => page.goBack())
  expect(back.at(-1)).toMatchObject({ type: 'success', trigger: 'popstate' })
  expect(await page.evaluate(() => scrollY)).toBe(1500)
  await follow(page, '/a/one')
  await follow(page, '/long#target')
  expect(await page.evaluate(() => Math.abs(document.getElementById('target')!.getBoundingClientRect().top))).toBeLessThan(2)
  await expectFullLoadParity(page)
  await close()
})

// ---- item 9: data-brust-persist ------------------------------------------------------------------------------------------

test('a data-brust-persist element is the same node after a navigation, across root layouts too', async () => {
  const { page, close } = await open('/')
  await page.evaluate(() => { (document.getElementById('player') as unknown as Record<string, number>).__same = 1 })
  await follow(page, '/r2/one') // another root layout: the whole body is swapped
  expect(await page.evaluate(() => (document.getElementById('player') as unknown as Record<string, number>).__same)).toBe(1)
  await follow(page, '/b/one')
  expect(await page.evaluate(() => (document.getElementById('player') as unknown as Record<string, number>).__same)).toBe(1)
  await close()
})

// ---- item 10: prefetch ---------------------------------------------------------------------------------------------------

test('prefetch: hover then click is one request; data-brust-prefetch="false" prefetches nothing', async () => {
  const { page, close } = await open('/')
  const hits: string[] = []
  page.on('request', (r) => { if (r.resourceType() === 'fetch') hits.push(new URL(r.url()).pathname) })
  await page.hover('nav a[href="/list"]')
  await Bun.sleep(200) // the hover intent is 65 ms
  expect(hits).toEqual(['/list'])
  await follow(page, '/list')
  expect(hits).toEqual(['/list'])
  await page.evaluate(() => document.querySelector('nav a[href="/b/one"]')!.setAttribute('data-brust-prefetch', 'false'))
  await page.hover('nav a[href="/b/one"]')
  await Bun.sleep(200)
  expect(hits).toEqual(['/list'])
  await close()
})

// ---- item 11: opt-outs -----------------------------------------------------------------------------------------------------

test('opt-outs: data-brust-reload on a link and on <html>, a modifier click, target=_blank', async () => {
  for (const where of ['a', 'html']) {
    const { page, close } = await open('/')
    await page.evaluate((w) => (w === 'a' ? document.querySelector('nav a[href="/b/one"]')! : document.documentElement).setAttribute('data-brust-reload', ''), where)
    await Promise.all([page.waitForURL(`${base}/b/one`), page.click('nav a[href="/b/one"]')])
    await page.waitForFunction(() => document.querySelector('[data-page=b-one]'))
    expect(await page.evaluate(() => window.__mark)).toBeUndefined()
    expect(await page.evaluate(() => window.__navlog.length)).toBe(0)
    await close()
  }
  const { page, close } = await open('/')
  const popup = page.context().waitForEvent('page')
  await page.click('nav a[href="/b/one"]', { modifiers: ['ControlOrMeta'] })
  await (await popup).close()
  await page.evaluate(() => document.querySelector('nav a[href="/b/two"]')!.setAttribute('target', '_blank'))
  const popup2 = page.context().waitForEvent('page')
  await page.click('nav a[href="/b/two"]')
  await (await popup2).close()
  expect(await page.evaluate(() => window.__navlog.length)).toBe(0)
  expect(new URL(page.url()).pathname).toBe('/')
  expect(await page.evaluate(() => window.__mark)).toBe(1)
  await close()
})

// ---- item 12: deploy skew ------------------------------------------------------------------------------------------------------

test('a response from another build is a full load', async () => {
  const { page, close } = await open('/')
  await page.route('**/b/one', async (r) => {
    if (r.request().resourceType() !== 'fetch') return r.continue()
    const res = await r.fetch()
    await r.fulfill({ response: res, body: (await res.text()).replace(/data-brust-build="[^"]*"/, 'data-brust-build="another"') })
  })
  const ev = await nav(page, () => page.click('nav a[href="/b/one"]'))
  expect(ev.at(-1)).toMatchObject({ type: 'error', swapped: false })
  await page.waitForFunction(() => window.__mark === undefined && document.querySelector('[data-page=b-one]'))
  await close()
})

// ---- item 13: --target static ----------------------------------------------------------------------------------------------------

test('--target static: A -> B navigates from the static files and equals a full load of them', async () => {
  const { page, errors, close } = await open('/', staticBase)
  for (const to of ['/a/one', '/b/one', '/r2/one', '/list']) {
    const ev = await follow(page, to)
    expect(ev.at(-1)).toMatchObject({ type: 'success' })
    await expectFullLoadParity(page)
  }
  expect(errors).toEqual([])
  await close()
})

// ---- item 14: the layout matrix -----------------------------------------------------------------------------------------------------

/** Each page's layouts, root first, with what its own markup depends on (A's active link). */
const CHAIN: Record<string, string[]> = {
  '/': ['R1'],
  '/missing': ['R1'],
  '/a/one': ['R1', 'A:one'],
  '/a/two': ['R1', 'A:two'],
  '/a/deep/x': ['R1', 'A:', 'A2'],
  '/a/deep/y': ['R1', 'A:', 'A2'],
  '/b/one': ['R1', 'B'],
  '/b/two': ['R1', 'B'],
  '/p/x': ['R1', 'P'],
  '/p/y': ['R1', 'P'],
  '/t/x': ['R1', 'T'],
  '/t/y': ['R1', 'T'],
  '/r2/one': ['R2'],
  '/r2/two': ['R2'],
}
/** The layouts a navigation u -> v keeps (design §5.9): the equal prefix, never the page, one level up from P and T. */
function kept(u: string, v: string): string[] {
  const a = [...CHAIN[u]!, `page:${u}`]
  const b = [...CHAIN[v]!, `page:${v}`]
  if (a[0] !== b[0]) return []
  const leaf = Math.min(a.length, b.length) - 1
  let i = 1
  while (i < leaf && a[i] === b[i]) i++
  // the page's pair under P or T is not a range in its document: the swap starts one level higher
  const split = (c: string[]) => i === c.length - 1 && /^[PT]$/.test(c[i - 1]!)
  if (split(a) || split(b)) i--
  return a.slice(0, i).map((l) => l.split(':')[0]!)
}
/** Every ordered pair once: an Eulerian circuit of the complete digraph (Hierholzer). */
function circuit(nodes: string[]): string[] {
  const left = new Map(nodes.map((n) => [n, nodes.filter((m) => m !== n)]))
  const stack = [nodes[0]!]
  const path: string[] = []
  while (stack.length) {
    const top = stack.at(-1)!
    const next = left.get(top)!.shift()
    if (next) stack.push(next)
    else path.push(stack.pop()!)
  }
  return path.reverse()
}
async function clickUntil(page: Page, sel: string, want: string) {
  for (let i = 0; i < 40; i++) {
    await page.click(sel)
    try { await page.waitForFunction(([s, w]) => document.querySelector(s!)?.textContent?.trim() === w, [sel, want], { timeout: 100 }); return }
    catch {}
    if ((await page.textContent(sel))?.trim() === want) return
  }
  throw new Error(`${sel} never reached ${want}`)
}
const counters = (page: Page) =>
  page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-count]')].map((e) => [e.getAttribute('data-count')!, e.textContent!.trim()])))

test('layout matrix: every ordered pair of pages equals a full load, keeps exactly the equal layouts, never nests', async () => {
  const pages = Object.keys(CHAIN)
  const walk = circuit(pages)
  expect(walk.length).toBe(pages.length * (pages.length - 1) + 1)
  const { page, errors, close } = await open(walk[0]!)
  for (let s = 1; s < walk.length; s++) {
    const [u, v] = [walk[s - 1]!, walk[s]!]
    // give every counter on screen a value of its own (a kept layout keeps it, a replaced one is back at 0)
    for (const [name, value] of Object.entries(await counters(page))) await clickUntil(page, `[data-count="${name}"]`, String(Number(value) + 1))
    const before = await counters(page)
    const ev = await follow(page, v)
    expect([u, v, ev.at(-1)!.type]).toEqual([u, v, v === '/missing' ? 'error' : 'success'])
    await expectFullLoadParity(page)
    // no layout twice, and exactly v's layouts
    const layouts = await page.evaluate(() => [...document.querySelectorAll('[data-layout]')].map((e) => e.getAttribute('data-layout')))
    expect([u, v, layouts]).toEqual([u, v, CHAIN[v]!.map((l) => l.split(':')[0])])
    const keep = kept(u, v)
    const after = await counters(page)
    for (const [name, value] of Object.entries(after)) {
      const layout = name.replace('-island', '')
      expect([u, v, name, value]).toEqual([u, v, name, keep.includes(layout) ? before[name] : '0'])
    }
  }
  expect(errors).toEqual([])
  await close()
}, 300_000)
