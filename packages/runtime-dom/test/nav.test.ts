// The SPA navigation module (design docs/design/2026-10-25-spa-navigation-design.md, F454) under happy-dom: the level
// chain and which level is swapped (§5.9), the head plan (§3 step 5), the body swap with persisted elements, and the
// whole flow from a click to the events (§4) with a stubbed fetch. The served Chromium tests (tests/server/spa-nav*)
// check the same against a real server and a full load.
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { between, readChain, swapLevel } from '../src/nav/chain'
import { applyHead, classicScripts, planHead, swapBody } from '../src/nav/swap'
import { boot, type NavBridge } from '../src/nav/nav'

;(window as unknown as { happyDOM: { settings: { disableCSSFileLoading: boolean } } }).happyDOM.settings.disableCSSFileLoading = true

const L = (id: string, hash: string, inner: string) => `<!--brust-l:${id}:${hash}-->${inner}<!--/brust-l:${id}-->`
interface Page { head?: string; body: string; root?: string; build?: string; tail?: string; html?: string; bodyAttrs?: string }
const doc = (p: Page) =>
  `<!doctype html><html${p.html ?? ''}><head>${p.head ?? ''}</head><body${p.bodyAttrs ?? ''}>${p.body}` +
  `<script type="module" src="/_brust/client/nav-1.js" data-brust-nav data-brust-build="${p.build ?? 'b1'}" data-brust-root="${p.root ?? 'R:1'}"></script>${p.tail ?? ''}</body></html>`
const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html')

/** Make the live document the parsed page (head, body and the attributes of both). */
function show(p: Page): void {
  const d = parse(doc(p))
  for (const [to, from] of [[document.documentElement, d.documentElement], [document.body, d.body]] as const) {
    for (const a of Array.from(to.attributes)) to.removeAttribute(a.name)
    for (const a of Array.from(from.attributes)) to.setAttribute(a.name, a.value)
  }
  document.head.replaceChildren(...Array.from(d.head.childNodes))
  document.body.replaceChildren(...Array.from(d.body.childNodes))
}
const $ = (sel: string) => document.querySelector(sel)

// ---- chain ----------------------------------------------------------------------------------------

test('readChain reads the root from the nav tag and the level pairs outermost first', () => {
  const c = readChain(parse(doc({ body: `<nav>x</nav>${L('docs', 'aa', `<aside></aside>${L('page', 'bb', '<p>a</p>')}`)}` })))!
  expect(c.map((l) => l.key)).toEqual(['R:1', 'docs:aa', 'page:bb'])
  expect(c[1]!.open!.data).toBe('brust-l:docs:aa')
  expect(c[1]!.close!.data).toBe('/brust-l:docs')
  expect(between(c[2]!).map((n) => n.nodeName)).toEqual(['#comment', 'P', '#comment'])
})

test('readChain refuses a document it cannot trust', () => {
  expect(readChain(parse('<html><body>' + L('a', '1', '') + '</body></html>'))).toBeNull() // no nav tag: no root
  expect(readChain(parse(doc({ body: '<!--brust-l:a:1-->' })))).toBeNull() // unbalanced
  expect(readChain(parse(doc({ body: '<!--brust-l:a:1--><!--/brust-l:b-->' })))).toBeNull() // wrong close
  expect(readChain(parse(doc({ body: L('a', '1', '') + L('b', '2', '') })))).toBeNull() // two levels side by side
  expect(readChain(parse(doc({ body: '<p>no levels</p>' })))!.length).toBe(1)
  // an id with a colon: the hash is after the last one
  expect(readChain(parse(doc({ body: L('routes:docs', 'ff', '') })))![1]!.key).toBe('routes:docs:ff')
})

test('swapLevel: the first level that differs, never the page, the whole body on a root change', () => {
  const c = (...lv: [string, string][]) => readChain(parse(doc({ body: lv.reduceRight((inner, [id, h]) => L(id, h, inner), '<i></i>') })))
  const rp = (page: string) => c(['D', '1'], ['P', page])
  expect(swapLevel(rp('a'), rp('b'))).toBe(2) // same layout: the page
  expect(swapLevel(rp('a'), rp('a'))).toBe(2) // the same page again: still swapped
  expect(swapLevel(c(['D', '1'], ['P', 'a']), c(['D', '2'], ['P', 'a']))).toBe(1) // the layout's own markup changed
  expect(swapLevel(c(['D', '1'], ['P', 'a']), c(['B', '1'], ['P', 'a']))).toBe(1) // a sibling layout
  expect(swapLevel(c(['A', '1'], ['P', 'a']), c(['A', '1'], ['A2', '1'], ['P', 'b']))).toBe(2) // down a level
  expect(swapLevel(c(['A', '1'], ['A2', '1'], ['P', 'b']), c(['A', '1'], ['P', 'a']))).toBe(2) // up a level
  expect(swapLevel(c(), c(['A', '1']))).toBe(0) // a page with no level under the root
  const other = readChain(parse(doc({ root: 'R2:1', body: L('D', '1', L('P', 'b', '')) })))
  expect(swapLevel(rp('a'), other)).toBe(0) // another root layout
  expect(swapLevel(rp('a'), null)).toBe(0)
})

test('swapLevel moves up a level when the parser split a pair (outlet in <p>, in a <table>)', () => {
  const ok = readChain(parse(doc({ body: L('D', '1', L('P', 'a', '<i></i>')) })))
  // `<div>` closes the `<p>`: the page pair is no longer a sibling pair
  const p = readChain(parse(doc({ body: L('D', '1', `<p>${L('P', 'b', '<div>x</div>')}</p>`) })))!
  expect(p[2]!.open!.parentNode).not.toBe(p[2]!.close!.parentNode)
  expect(swapLevel(ok, p)).toBe(1)
  // the root level's pair split too: the whole body
  const both = readChain(parse(doc({ body: `<p>${L('D', '1', `${L('P', 'b', '<div>x</div>')}`)}</p>` })))
  expect(swapLevel(ok, both)).toBe(0)
  // foster parenting: the parser moves a block out in front of the table and leaves the comments in it, siblings
  // around nothing; a pair in a table section is never a range
  const t = readChain(parse(doc({ body: L('D', '1', `<table>${L('P', 'b', '<div id="fostered">x</div>')}</table>`) })))!
  expect(t[2]!.open!.parentNode).toBe(t[2]!.close!.parentNode)
  // (Chromium leaves the pair around nothing; happy-dom fosters only the element: the served table case checks Chromium)
  expect(swapLevel(ok, t)).toBe(1)
  const rows = readChain(parse(doc({ body: L('D', '1', `<table><tbody>${L('P', 'b', '<tr><td>x</td></tr>')}</tbody></table>`) })))!
  expect(swapLevel(ok, rows)).toBe(1)
})

// ---- head ------------------------------------------------------------------------------------------

test('the head becomes the new head in its order; equal elements are the same nodes; no kept stylesheet moves', () => {
  show({ head: '<title>A</title><meta name="description" content="a"><link rel="stylesheet" href="/s.css"><link rel="stylesheet" href="/x.css"><link rel="stylesheet" href="/y.css">', body: '' })
  const shared = $('link[href="/s.css"]')!
  const x = $('link[href="/x.css"]')!
  const y = $('link[href="/y.css"]')!
  const next = parse(doc({ head: '<title>B</title><link rel="canonical" href="/b"><link rel="stylesheet" href="/s.css"><link rel="stylesheet" href="/y.css"><link rel="stylesheet" href="/x.css"><link rel="stylesheet" href="/n.css" media="screen">', body: '' }))
  const plan = planHead(Array.from(next.head.children))
  // y stays (the longest run in order is s, y), x out of order is loaded again at its place, n is new
  expect(plan.sheets.map(([e, m]) => [e.getAttribute('href'), m])).toEqual([['/x.css', null], ['/n.css', 'screen']])
  for (const [e] of plan.sheets) {
    expect(e.getAttribute('media')).toBe('not all')
    expect(e.ownerDocument).toBe(document)
    expect(e.parentNode).toBe(document.head) // loading at its final place, before the swap
  }
  for (const [e, m] of plan.sheets) m == null ? e.removeAttribute('media') : e.setAttribute('media', m)
  const fresh = applyHead(plan)
  expect(Array.from(document.head.children, (e) => e.outerHTML)).toEqual(Array.from(parse(doc({ head: '<title>B</title><link rel="canonical" href="/b"><link rel="stylesheet" href="/s.css"><link rel="stylesheet" href="/y.css"><link rel="stylesheet" href="/x.css"><link rel="stylesheet" href="/n.css" media="screen">', body: '' })).head.children, (e) => e.outerHTML))
  expect($('link[href="/s.css"]')).toBe(shared)
  expect($('link[href="/y.css"]')).toBe(y)
  expect(x.isConnected).toBe(false)
  expect(fresh.map((e) => e.localName)).toEqual(['title', 'link'])
  expect(document.title).toBe('B')
})

test('a stylesheet never moves: a new element goes around the kept ones', () => {
  show({ head: '<link rel="stylesheet" href="/s.css"><meta name="a" content="1"><title>A</title>', body: '' })
  const s = $('link')!
  const meta = $('meta')!
  const moves: Node[] = []
  const mo = new MutationObserver((rs) => rs.forEach((r) => r.removedNodes.forEach((n) => moves.push(n))))
  mo.observe(document.head, { childList: true })
  const next = parse(doc({ head: '<title>B</title><meta name="a" content="1"><link rel="stylesheet" href="/s.css">', body: '' }))
  applyHead(planHead(Array.from(next.head.children)))
  mo.takeRecords().forEach((r) => r.removedNodes.forEach((n) => moves.push(n)))
  mo.disconnect()
  expect(Array.from(document.head.children, (e) => e.localName)).toEqual(['title', 'meta', 'link'])
  expect($('link')).toBe(s)
  expect($('meta')).toBe(meta)
  expect(moves).not.toContain(s)
})

// ---- body ------------------------------------------------------------------------------------------

const app = (layout: string, page: string, extra = '') => ({ body: `<header id="h">site</header>${L('D', layout, `<aside id="side">docs</aside>${L('P', page, `<main id="m">${page}</main>${extra}`)}`)}`, tail: '<script type="module" src="/_brust/client/core-1.js"></script>' })

test('a level swap replaces the page only; the root and the kept layout are the same nodes; the tail is the new one', () => {
  show(app('1', 'a'))
  const header = $('#h')!
  const side = $('#side')!
  const next = parse(doc({ ...app('1', 'b'), tail: '<script data-brust-store="s" type="application/json">{}</script><script type="module" src="/_brust/client/chunk-b.js"></script>' }))
  const [added, whole] = swapBody(next, 'data-brust-loading')
  expect(whole).toBe(false)
  expect($('#h')).toBe(header)
  expect($('#side')).toBe(side)
  expect($('#m')!.textContent).toBe('b')
  expect(readChain(document)!.map((l) => l.key)).toEqual(['R:1', 'D:1', 'P:b'])
  expect(document.body.innerHTML).toBe(parse(doc({ ...app('1', 'b'), tail: '<script data-brust-store="s" type="application/json">{}</script><script type="module" src="/_brust/client/chunk-b.js"></script>' })).body.innerHTML)
  expect(added.some((n) => (n as Element).getAttribute?.('data-brust-store') === 's')).toBe(true)
})

test('a changed layout is replaced with its page; a persisted element is moved, not re-created', () => {
  show(app('1', 'a', '<video data-brust-persist="v" id="old"></video>'))
  const video = $('video')!
  const header = $('#h')!
  swapBody(parse(doc(app('2', 'b', '<video data-brust-persist="v" id="new"></video>'))), 'data-brust-loading')
  expect($('#h')).toBe(header)
  expect($('video')).toBe(video)
  expect($('video')!.id).toBe('old')
  expect($('#side')!.isConnected).toBe(true)
})

test('a root change swaps the whole body and the attributes of <html> and <body>, keeping data-brust-loading', () => {
  show({ ...app('1', 'a'), html: ' lang="en" class="a"', bodyAttrs: ' class="ba"' })
  document.documentElement.setAttribute('data-brust-loading', '')
  const header = $('#h')!
  expect(swapBody(parse(doc({ ...app('1', 'b'), root: 'R2:9', html: ' lang="th"', bodyAttrs: ' data-x="1"' })), 'data-brust-loading')[1]).toBe(true)
  expect($('#h')).not.toBe(header)
  expect(document.documentElement.getAttribute('lang')).toBe('th')
  expect(document.documentElement.hasAttribute('class')).toBe(false)
  expect(document.documentElement.hasAttribute('data-brust-loading')).toBe(true)
  expect(document.body.getAttribute('data-x')).toBe('1')
  expect(document.body.hasAttribute('class')).toBe(false)
})

test('classicScripts picks the scripts a full load runs: not modules, not JSON', () => {
  const d = parse('<div><script>a</script><script type="module">b</script><script type="application/json">c</script><script type="text/javascript">d</script></div>')
  expect(classicScripts([d.body.firstChild!]).map((s) => s.text)).toEqual(['a', 'd'])
})

// ---- the flow ----------------------------------------------------------------------------------------

type Ev = [string, Record<string, unknown>, boolean]
let stop = () => {}
let events: Ev[] = []
let pages: Record<string, { status?: number; html: string; type?: string } | Error> = {}
let fetched: string[] = []
let loaded: string[] = []
const realFetch = globalThis.fetch

beforeEach(() => {
  ;(window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL('http://localhost/a')
  history.replaceState(null, '', '/a')
  events = []
  fetched = []
  loaded = []
  pages = {}
  globalThis.fetch = (async (u: string) => {
    fetched.push(String(u))
    const p = pages[new URL(String(u)).pathname]
    if (!p) throw new TypeError('network down')
    if (p instanceof Error) throw p
    return new Response(p.html, { status: p.status ?? 200, headers: { 'content-type': p.type ?? 'text/html; charset=utf-8' } })
  }) as typeof fetch
  for (const n of ['click', 'load', 'success', 'error'])
    document.addEventListener('brust:nav:' + n, record, { signal: (listen = new AbortController()).signal })
})
let listen = new AbortController()
const record = (e: Event) => events.push([e.type.slice(10), (e as CustomEvent).detail, document.documentElement.hasAttribute('data-brust-loading')])
afterEach(() => {
  listen.abort()
  stop()
  globalThis.fetch = realFetch
})

const start = (p: Page = app('1', 'a')) => {
  show({ ...p, body: `${p.body}<a id="to-b" href="/b">b</a>` })
  stop = boot(async (u) => { loaded.push(new URL(u).pathname + (document.querySelector('script[data-brust-store="s"]') ? '+store' : '')) })
}
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)) }
const click = (el: Element, init: MouseEventInit = {}) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init }))
const names = () => events.map((e) => e[0])

test('a link click: click, load, success with one id; the page swapped, the URL pushed, loading only in between', async () => {
  start()
  const header = $('#h')!
  pages['/b'] = { html: doc({ ...app('1', 'b'), head: '<title>B</title>' }) }
  const len = history.length
  click($('#to-b')!)
  await settle()
  expect(names()).toEqual(['click', 'load', 'success'])
  expect(new Set(events.map((e) => e[1].id)).size).toBe(1)
  expect(events.map((e) => e[2])).toEqual([false, true, false]) // data-brust-loading at load, gone at success
  expect(events[1]![1]).toMatchObject({ url: 'http://localhost/b', from: 'http://localhost/a', trigger: 'link' })
  expect(events[2]![1]).toMatchObject({ url: 'http://localhost/b', status: 200, trigger: 'link' })
  expect(location.pathname).toBe('/b')
  expect(history.length).toBe(len + 1)
  expect(history.state.brust).toBeString()
  expect(document.title).toBe('B')
  expect($('#m')!.textContent).toBe('b')
  expect($('#h')).toBe(header)
  expect(document.documentElement.hasAttribute('data-brust-loading')).toBe(false)
})

test('the new page\'s store tags are in the document before its modules load, which load in document order', async () => {
  start()
  pages['/b'] = { html: doc({ ...app('1', 'b'), head: '<script type="module" src="/_brust/h.js"></script>', tail: '<script data-brust-store="s" type="application/json">{"n":1}</script><script type="module" src="/_brust/client/core-1.js"></script><script type="module" src="/_brust/client/for-1.js"></script>' }) }
  click($('#to-b')!)
  await settle()
  expect(loaded).toEqual(['/_brust/h.js+store', '/_brust/client/core-1.js+store', '/_brust/client/for-1.js+store'])
  expect(names()).toEqual(['click', 'load', 'success'])
  expect(document.querySelectorAll('script[data-brust-store="s"]').length).toBe(1) // the one in the new tail
})

test('a 404 brust page is swapped in and ends with error { status: 404, swapped: true }', async () => {
  start()
  pages['/b'] = { status: 404, html: doc({ body: '<h1 id="nf">not found</h1>' }) }
  const assign = spyOn(location, 'assign').mockImplementation(() => {})
  click($('#to-b')!)
  await settle()
  expect(names()).toEqual(['click', 'load', 'error'])
  expect(events[2]![1]).toMatchObject({ status: 404, swapped: true })
  expect($('#nf')).not.toBeNull()
  expect(location.pathname).toBe('/b')
  expect(assign).not.toHaveBeenCalled()
  assign.mockRestore()
})

test('nothing swappable (network, another build, not HTML, a failed import) is error { swapped: false } and a full load', async () => {
  const assign = spyOn(location, 'assign').mockImplementation(() => {})
  for (const p of [undefined, { html: doc({ ...app('1', 'b'), build: 'b2' }) }, { html: '{}', type: 'application/json' }, { html: '<html><body>plain</body></html>' }]) {
    start()
    events = []
    if (p) pages['/b'] = p
    else delete pages['/b']
    click($('#to-b')!)
    await settle()
    expect(names()).toEqual(['click', 'load', 'error'])
    expect(events[2]![1]).toMatchObject({ swapped: false, url: 'http://localhost/b' })
    expect(events[2]![1].error).toBeInstanceOf(Error)
    expect($('#m')!.textContent).toBe('a')
    expect(assign).toHaveBeenLastCalledWith('http://localhost/b')
    stop()
  }
  // a module that fails to import
  assign.mockClear()
  show(app('1', 'a'))
  document.body.insertAdjacentHTML('afterbegin', '<a id="to-b" href="/b">b</a>')
  stop = boot(async () => { throw new Error('import failed') })
  pages['/b'] = { html: doc(app('1', 'b')) }
  events = []
  click($('#to-b')!)
  await settle()
  expect(events.at(-1)![1]).toMatchObject({ swapped: false })
  expect(assign).toHaveBeenCalledWith('http://localhost/b')
  assign.mockRestore()
})

test('preventDefault on the error event cancels the full load', async () => {
  start()
  const assign = spyOn(location, 'assign').mockImplementation(() => {})
  document.addEventListener('brust:nav:error', (e) => e.preventDefault(), { once: true })
  click($('#to-b')!)
  await settle()
  expect(names()).toEqual(['click', 'load', 'error'])
  expect(assign).not.toHaveBeenCalled()
  assign.mockRestore()
})

test('clicks left to the browser: modifiers, other buttons, target, download, data-brust-reload, other origin, hash only, prevented', async () => {
  start()
  pages['/b'] = { html: doc(app('1', 'b')) }
  // happy-dom follows a link it is left to: stop that at window, after nav's document listener has decided
  const browser = (e: Event) => e.preventDefault()
  window.addEventListener('click', browser)
  const a = $('#to-b')!
  for (const init of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) click(a, init)
  const variants: [string, string][] = [['target', '_blank'], ['download', ''], ['data-brust-reload', '']]
  for (const [k, v] of variants) { a.setAttribute(k, v); click(a); a.removeAttribute(k) }
  document.documentElement.setAttribute('data-brust-reload', '')
  click(a)
  document.documentElement.removeAttribute('data-brust-reload')
  for (const href of ['https://other.example/b', '#top', '/a#x', 'mailto:x@y.z']) { a.setAttribute('href', href); click(a) }
  a.setAttribute('href', '/b')
  a.addEventListener('click', (e) => e.preventDefault(), { once: true, capture: true })
  click(a)
  const off = (e: Event) => e.preventDefault()
  document.addEventListener('brust:nav:click', off)
  click(a)
  document.removeEventListener('brust:nav:click', off)
  await settle()
  expect(fetched).toEqual([])
  window.removeEventListener('click', browser)
  expect(names()).toEqual(['click']) // only the one the click listener cancelled
  expect(location.pathname).toBe('/a')
})

test('a link to the URL on screen re-fetches and replaces the entry', async () => {
  start()
  pages['/a'] = { html: doc(app('1', 'a2')) }
  $('#to-b')!.setAttribute('href', '/a')
  const len = history.length
  click($('#to-b')!)
  await settle()
  expect(names()).toEqual(['click', 'load', 'success'])
  expect(history.length).toBe(len)
  expect($('#m')!.textContent).toBe('a2')
})

test('prefetch on focus: one request used by the click; data-brust-prefetch="false" and saveData skip it', async () => {
  start()
  pages['/b'] = { html: doc(app('1', 'b')) }
  const a = $('#to-b')!
  a.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
  a.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
  expect(fetched).toEqual(['http://localhost/b'])
  expect(events).toEqual([]) // a prefetch fires no event
  click(a)
  await settle()
  expect(fetched).toEqual(['http://localhost/b'])
  expect(names()).toEqual(['click', 'load', 'success'])
  stop()

  start()
  fetched = []
  $('#to-b')!.setAttribute('data-brust-prefetch', 'false')
  $('#to-b')!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
  expect(fetched).toEqual([])
})

test('hover prefetches after 65 ms, and not when the pointer leaves first', async () => {
  start()
  pages['/b'] = { html: doc(app('1', 'b')) }
  const a = $('#to-b')!
  a.dispatchEvent(new PointerEvent('pointerenter'))
  a.dispatchEvent(new PointerEvent('pointerleave'))
  await new Promise((r) => setTimeout(r, 90))
  expect(fetched).toEqual([])
  a.dispatchEvent(new PointerEvent('pointerenter'))
  await new Promise((r) => setTimeout(r, 90))
  expect(fetched).toEqual(['http://localhost/b'])
})

test('a newer navigation supersedes the one in flight: it fires nothing more', async () => {
  start()
  let release!: () => void
  const slow = new Promise<void>((r) => (release = r))
  pages['/b'] = { html: doc(app('1', 'b')) }
  pages['/c'] = { html: doc(app('1', 'c')) }
  const f = globalThis.fetch
  globalThis.fetch = (async (u: string, init?: RequestInit) => {
    if (String(u).endsWith('/b')) await slow
    return f(u, init)
  }) as typeof fetch
  click($('#to-b')!)
  const nav = (globalThis as unknown as Record<symbol, NavBridge>)[Symbol.for('brust.nav')]!
  const done = nav.navigate('/c')
  release()
  await done
  await settle()
  expect(names()).toEqual(['click', 'load', 'load', 'success'])
  expect(events[3]![1]).toMatchObject({ trigger: 'navigate', url: 'http://localhost/c' })
  expect(events[1]![1].id).not.toBe(events[3]![1].id)
  expect($('#m')!.textContent).toBe('c')
})

test('back restores the page and its scroll position; the entry left is saved under its own id', async () => {
  start()
  pages['/b'] = { html: doc(app('1', 'b')) }
  pages['/a'] = { html: doc(app('1', 'a')) }
  const first = history.state.brust
  const scrolled: [number, number][] = []
  const sp = spyOn(window, 'scrollTo').mockImplementation(((x: number, y: number) => { scrolled.push([x, y]) }) as typeof scrollTo)
  Object.defineProperty(window, 'scrollY', { value: 300, configurable: true })
  click($('#to-b')!)
  await settle()
  Object.defineProperty(window, 'scrollY', { value: 50, configurable: true })
  history.replaceState({ brust: first }, '', '/a') // what the browser does on back: location and state first
  window.dispatchEvent(new PopStateEvent('popstate', { state: { brust: first } }))
  await settle()
  expect(names()).toEqual(['click', 'load', 'success', 'load', 'success'])
  expect(events[4]![1]).toMatchObject({ trigger: 'popstate', url: 'http://localhost/a', from: 'http://localhost/b' })
  expect(scrolled.at(-1)).toEqual([0, 300])
  expect($('#m')!.textContent).toBe('a')
  sp.mockRestore()
  Object.defineProperty(window, 'scrollY', { value: 0, configurable: true })
})

test('navigate() through the bridge; a full load when SPA navigation is off or the URL is elsewhere', async () => {
  start()
  pages['/b'] = { html: doc(app('1', 'b')) }
  const nav = (globalThis as unknown as Record<symbol, NavBridge>)[Symbol.for('brust.nav')]!
  await nav.navigate('/b')
  expect(names()).toEqual(['load', 'success'])
  expect(events[0]![1].trigger).toBe('navigate')
  const assign = spyOn(location, 'assign').mockImplementation(() => {})
  await nav.navigate('https://other.example/')
  document.body.setAttribute('data-brust-reload', '')
  await nav.navigate('/c')
  document.body.removeAttribute('data-brust-reload')
  expect(assign.mock.calls).toEqual([['https://other.example/'], ['http://localhost/c']])
  assign.mockRestore()
})

test('head scripts: all re-run after a whole-body swap (data-brust-once only when new), only new ones on a level swap', async () => {
  const head = '<script id="theme">document.documentElement.className = "dark"</script><script id="once" data-brust-once>1</script>'
  start({ ...app('1', 'a'), head })
  const theme = $('#theme')
  const once = $('#once')
  pages['/b'] = { html: doc({ ...app('1', 'b'), head: head + '<script id="new-b">2</script>' }) }
  pages['/c'] = { html: doc({ ...app('1', 'c'), root: 'R2:1', head: head + '<script id="new-c" data-brust-once>3</script>' }) }
  click($('#to-b')!)
  await settle()
  // a level swap: the reused ones are the same nodes (not run again), the new one was re-created to run
  expect($('#theme')).toBe(theme)
  expect($('#once')).toBe(once)
  const newB = $('#new-b')
  expect(newB).not.toBeNull()
  const nav = (globalThis as unknown as Record<symbol, NavBridge>)[Symbol.for('brust.nav')]!
  await nav.navigate('/c')
  await settle()
  // a whole-body swap: every classic head script re-created (run) except the reused data-brust-once one
  expect($('#theme')).not.toBe(theme)
  expect($('#theme')!.outerHTML).toBe(theme!.outerHTML)
  expect($('#once')).toBe(once)
  expect($('#new-c')).not.toBeNull()
  expect(names().filter((n) => n === 'success').length).toBe(2)
})

test('boot does nothing on a page without a nav tag, and only once', () => {
  document.body.replaceChildren()
  expect(boot()).toBeFunction()
  expect((globalThis as Record<symbol, unknown>)[Symbol.for('brust.nav')]).toBeUndefined()
  start()
  const again = boot()
  again()
  expect((globalThis as Record<symbol, unknown>)[Symbol.for('brust.nav')]).toBeDefined()
})
