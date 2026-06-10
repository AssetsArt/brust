// DOM is not available in bun's default environment. We install happy-dom
// globals in beforeAll so this file is self-contained (no --preload needed).
import { test, expect, afterAll, beforeAll, beforeEach, mock } from 'bun:test'
import { Window } from 'happy-dom'
import { getNavState, subscribe, __resetNavForTest } from '../navigation/store.ts'

// isInternalLink and hydrateMarkersIn are imported lazily (after DOM is up)
// via a module-level variable populated in beforeAll.
let isInternalLink: (a: HTMLAnchorElement, e: MouseEvent) => boolean
let classifyClick: (
  a: HTMLAnchorElement,
  e: MouseEvent,
) => 'external' | 'hash' | 'reload' | 'navigate'
let hydrateMarkersIn: (root?: ParentNode) => void
let swapMainContent: (main: HTMLElement, html: string) => void
let hydrateOne: (el: HTMLElement) => Promise<void>
let unmountIslandsIn: (root: ParentNode) => void
let navigate: (url: URL, mode: 'push' | 'replace' | 'none') => Promise<void>
let isFullDocumentPayload: (html: string) => boolean

// react-dom/client is a STATIC top-level binding in bootstrap.ts, so the mock
// must be registered before `await import('./bootstrap')` runs (below) for it
// to rewire createRoot/hydrateRoot. Spies live at module scope so the
// per-test branch assertions can read call counts; beforeEach clears them so
// one test's calls don't leak into the next ("NOT createRoot" assertions).
const unmountSpy = mock(() => {})
const renderSpy = mock(() => {})
const createRootSpy = mock(() => ({ render: renderSpy, unmount: unmountSpy }))
const hydrateRootSpy = mock(() => ({ unmount: unmountSpy }))

beforeEach(() => {
  unmountSpy.mockClear()
  renderSpy.mockClear()
  createRootSpy.mockClear()
  hydrateRootSpy.mockClear()
})

// The navigate() tests below replace globalThis.fetch with a json-only stub.
// bun test runs every file in ONE process, so without a restore the stub leaks
// into later files (it broke ssg.test.ts's real crawl with "resp.text is not a
// function"). Restore the real fetch when this file is done.
const realFetch = globalThis.fetch
afterAll(() => {
  globalThis.fetch = realFetch
})

beforeAll(async () => {
  // Registered before the bootstrap import below so the static binding picks
  // up the spies. The chunk module (/_brust/islands/<id>.js) is also mocked so
  // hydrateOne's dynamic import resolves to a trivial component in test.
  mock.module('react-dom/client', () => ({
    createRoot: createRootSpy,
    hydrateRoot: hydrateRootSpy,
  }))
  mock.module('/_brust/islands/Counter.js', () => ({ default: () => null }))
  mock.module('/_brust/islands/Server.js', () => ({ default: () => null }))

  const win = new Window({ url: 'http://localhost/' })
  // happy-dom 20.9.0 leaves win.SyntaxError/TypeError undefined, which
  // crashes its own querySelectorAll :not() implementation. Patch them.
  ;(win as unknown as Record<string, unknown>).SyntaxError = SyntaxError
  ;(win as unknown as Record<string, unknown>).TypeError = TypeError

  Object.assign(globalThis, {
    document: win.document,
    window: win,
    location: win.location,
    history: win.history,
    MouseEvent: win.MouseEvent,
    Event: win.Event,
    HTMLElement: win.HTMLElement,
    HTMLAnchorElement: (win as unknown as Record<string, unknown>).HTMLAnchorElement,
    DOMParser: (win as unknown as Record<string, unknown>).DOMParser,
    scrollTo: () => {},
    // IntersectionObserver intentionally absent — registerTrigger guards with typeof check
    // AbortController is provided natively by bun
  })

  // Import after globals are set so bootstrap's module-level guard
  // (typeof document !== 'undefined') sees the DOM correctly.
  const mod = await import('./bootstrap')
  isInternalLink = mod.isInternalLink
  classifyClick = mod.classifyClick
  hydrateMarkersIn = mod.hydrateMarkersIn
  swapMainContent = mod.swapMainContent
  hydrateOne = mod.hydrateOne
  unmountIslandsIn = mod.unmountIslandsIn
  navigate = mod.navigate
  isFullDocumentPayload = mod.isFullDocumentPayload
})

function makeLink(
  href: string,
  attrs: Partial<{ target: string; download: string; 'data-brust-no-intercept': string }> = {},
): HTMLAnchorElement {
  const a = document.createElement('a')
  a.href = href
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined) a.setAttribute(k, v)
  }
  return a
}

function plainClick(): MouseEvent {
  return new MouseEvent('click', {
    button: 0,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
  })
}

test('isInternalLink accepts plain same-origin <a href> on left click with no modifiers', () => {
  const a = makeLink('/blog/welcome')
  expect(isInternalLink(a, plainClick())).toBe(true)
})

test('isInternalLink rejects external origin, _blank, modifier-click, anchor, /_brust/, opt-out, download', () => {
  expect(isInternalLink(makeLink('https://example.com/x'), plainClick())).toBe(false)
  expect(isInternalLink(makeLink('/x', { target: '_blank' }), plainClick())).toBe(false)
  const a = makeLink('/x')
  expect(isInternalLink(a, new MouseEvent('click', { button: 0, metaKey: true }))).toBe(false)
  expect(isInternalLink(a, new MouseEvent('click', { button: 0, ctrlKey: true }))).toBe(false)
  expect(isInternalLink(a, new MouseEvent('click', { button: 0, shiftKey: true }))).toBe(false)
  expect(isInternalLink(a, new MouseEvent('click', { button: 0, altKey: true }))).toBe(false)
  expect(isInternalLink(a, new MouseEvent('click', { button: 1 }))).toBe(false)
  const anchor = makeLink(`${location.origin}${location.pathname}#section`)
  expect(isInternalLink(anchor, plainClick())).toBe(false)
  expect(isInternalLink(makeLink('/_brust/page/x'), plainClick())).toBe(false)
  expect(isInternalLink(makeLink('/x', { 'data-brust-no-intercept': '' }), plainClick())).toBe(
    false,
  )
  expect(isInternalLink(makeLink('/file.pdf', { download: '' }), plainClick())).toBe(false)
})

test('classifyClick: exact same URL → "reload" (must be suppressed, not a browser full reload)', () => {
  // location is http://localhost/ in this harness.
  expect(classifyClick(makeLink('http://localhost/'), plainClick())).toBe('reload')
  expect(classifyClick(makeLink('/'), plainClick())).toBe('reload')
})

test('classifyClick: same path, different hash → "hash" (native scroll, not intercepted)', () => {
  expect(classifyClick(makeLink('http://localhost/#section'), plainClick())).toBe('hash')
})

test('classifyClick: different path → "navigate" (SPA)', () => {
  expect(classifyClick(makeLink('/blog/welcome'), plainClick())).toBe('navigate')
})

test('classifyClick: not-ours → "external"', () => {
  expect(classifyClick(makeLink('https://example.com/x'), plainClick())).toBe('external')
  expect(classifyClick(makeLink('/_brust/page/x'), plainClick())).toBe('external')
  expect(classifyClick(makeLink('/x', { target: '_blank' }), plainClick())).toBe('external')
})

// Regression for the standalone-route shell-mismatch bug: a navigation payload
// that is a FULL document (a standalone route with no shared <main>) must be
// recognized so the navigator full-reloads instead of nesting it inside the
// current shell's <main> (the two-topbars / sidebar-on-home artifact).
test('isFullDocumentPayload: full <html>/<!doctype> → true (standalone route)', () => {
  expect(isFullDocumentPayload('<html lang="en"><head></head><body>…</body></html>')).toBe(true)
  expect(isFullDocumentPayload('<!doctype html><html></html>')).toBe(true)
  // tolerate leading whitespace and case
  expect(isFullDocumentPayload('  \n<HTML>')).toBe(true)
})

test('isFullDocumentPayload: inner <main> content → false (shared shell)', () => {
  expect(isFullDocumentPayload('<h1>Routing</h1><p>…</p>')).toBe(false)
  expect(isFullDocumentPayload('<div class="prose">…</div>')).toBe(false)
  expect(isFullDocumentPayload('')).toBe(false)
})

// Behavioral regression for the reported bug: clicking the link to the page you
// are already on must NOT trigger a full page reload. The installed click
// interceptor must call preventDefault() (so the browser does not navigate),
// while a hash-only link must be left to the browser's native scroll.
test('click interceptor: clicking the current URL is preventDefaulted (no full reload)', () => {
  const a = makeLink('http://localhost/')
  document.body.appendChild(a)
  try {
    const ev = new MouseEvent('click', { button: 0, bubbles: true, cancelable: true })
    a.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
  } finally {
    document.body.removeChild(a)
  }
})

test('click interceptor: hash-only link is NOT preventDefaulted (browser scrolls natively)', () => {
  const a = makeLink('http://localhost/#section')
  document.body.appendChild(a)
  try {
    const ev = new MouseEvent('click', { button: 0, bubbles: true, cancelable: true })
    a.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(false)
  } finally {
    document.body.removeChild(a)
  }
})

test('hydrateMarkersIn(root) only scans within the given root subtree', () => {
  const outside = document.createElement('div')
  outside.setAttribute('data-brust-island', 'Outside')
  outside.setAttribute('data-brust-props', '{}')
  document.body.appendChild(outside)

  const root = document.createElement('div')
  document.body.appendChild(root)
  const inside = document.createElement('div')
  inside.setAttribute('data-brust-island', 'Inside')
  inside.setAttribute('data-brust-props', '{}')
  root.appendChild(inside)

  try {
    hydrateMarkersIn(root)
    expect(inside.hasAttribute('data-brust-hydrated')).toBe(true)
    expect(outside.hasAttribute('data-brust-hydrated')).toBe(false)
  } finally {
    document.body.removeChild(outside)
    document.body.removeChild(root)
  }
})

test('swapMainContent terminates and replaces children with parsed HTML', () => {
  const main = document.createElement('main')
  const oldChild = document.createElement('p')
  oldChild.textContent = 'old'
  main.appendChild(oldChild)
  document.body.appendChild(main)

  try {
    swapMainContent(main as unknown as HTMLElement, '<h1>new title</h1><p>two</p>')
    // Loop terminates AND old children are gone, new children present.
    expect(main.children.length).toBe(2)
    expect(main.querySelector('h1')?.textContent).toBe('new title')
    expect(main.children[1]?.textContent).toBe('two')
    expect(main.contains(oldChild)).toBe(false)
  } finally {
    document.body.removeChild(main)
  }
}, 5_000)

test('hydrateMarkersIn is idempotent — second call on same root does not re-tag', () => {
  const root = document.createElement('div')
  const marker = document.createElement('div')
  marker.setAttribute('data-brust-island', 'X')
  marker.setAttribute('data-brust-props', '{}')
  root.appendChild(marker)
  document.body.appendChild(root)

  try {
    hydrateMarkersIn(root)
    expect(marker.getAttribute('data-brust-hydrated')).toBe('1')

    marker.setAttribute('data-brust-hydrated', 'seen')
    hydrateMarkersIn(root)
    expect(marker.getAttribute('data-brust-hydrated')).toBe('seen')
  } finally {
    document.body.removeChild(root)
  }
})

// hydrateOne is driven directly (not via hydrateMarkersIn) because the `load`
// trigger fires `void hydrateOne(el)` as a detached microtask — awaiting the
// call here makes the createRoot-vs-hydrateRoot branch deterministic.
function makeMarker(id: string, csr: boolean): HTMLElement {
  const el = document.createElement('div')
  el.setAttribute('data-brust-island', id)
  el.setAttribute('data-brust-props', '{}')
  if (csr) el.setAttribute('data-brust-csr', '')
  return el as unknown as HTMLElement
}

test('hydrateOne: client-only marker (data-brust-csr) uses createRoot+render, NOT hydrateRoot', async () => {
  const el = makeMarker('Counter', /* csr */ true)
  await hydrateOne(el)
  expect(createRootSpy).toHaveBeenCalledTimes(1)
  expect(createRootSpy).toHaveBeenCalledWith(el)
  expect(renderSpy).toHaveBeenCalledTimes(1)
  expect(hydrateRootSpy).not.toHaveBeenCalled()
})

test('hydrateOne: server marker (no data-brust-csr) uses hydrateRoot, NOT createRoot', async () => {
  const el = makeMarker('Server', /* csr */ false)
  await hydrateOne(el)
  expect(hydrateRootSpy).toHaveBeenCalledTimes(1)
  expect(hydrateRootSpy).toHaveBeenCalledWith(el, expect.anything())
  expect(createRootSpy).not.toHaveBeenCalled()
  expect(renderSpy).not.toHaveBeenCalled()
})

test('unmountIslandsIn unmounts a root created via the createRoot (CSR) path', async () => {
  const root = document.createElement('div')
  const el = makeMarker('Counter', /* csr */ true)
  root.appendChild(el)
  document.body.appendChild(root)

  try {
    // hydrateOne registers the createRoot-returned Root in islandRoots, so the
    // marker under `root` is now a tracked CSR root.
    await hydrateOne(el)
    expect(createRootSpy).toHaveBeenCalledTimes(1)
    expect(unmountSpy).not.toHaveBeenCalled()

    // unmountIslandsIn must find that root and unmount it — the same parity
    // path swapMainContent relies on to avoid hanging detached React roots.
    // createRoot's Root carries the same .unmount() as hydrateRoot's, so the
    // existing islandRoots/unmountIslandsIn machinery needs no special-casing.
    unmountIslandsIn(root as unknown as ParentNode)
    expect(unmountSpy).toHaveBeenCalledTimes(1)
  } finally {
    document.body.removeChild(root)
  }
})

test('navigate() drives nav store loading → success and commits path', async () => {
  __resetNavForTest()
  document.body.innerHTML = '<main></main>'
  ;(globalThis as Record<string, unknown>).fetch = mock(async () => ({
    ok: true,
    json: async () => ({ html: '<p>swapped</p>', title: 'Chart', store: undefined }),
  }))
  const phases: string[] = []
  const unsub = subscribe((s) => phases.push(s.phase))
  await navigate(new URL('http://localhost/type-chart'), 'push')
  unsub()
  expect(phases).toContain('loading')
  expect(getNavState().path).toBe('/type-chart')
  expect(getNavState().phase).toBe('success')
  expect(document.querySelector('main')!.textContent).toContain('swapped')
})

test('navigate mode: replace → replaceState, none → no history write, push → pushState', async () => {
  __resetNavForTest()
  document.body.innerHTML = '<main></main>'
  ;(globalThis as Record<string, unknown>).fetch = mock(async () => ({
    ok: true,
    json: async () => ({ html: '<p>x</p>', title: 'T' }),
  }))
  const push = mock(() => {})
  const replace = mock(() => {})
  ;(globalThis.history as unknown as Record<string, unknown>).pushState = push
  ;(globalThis.history as unknown as Record<string, unknown>).replaceState = replace
  await navigate(new URL('http://localhost/a'), 'push')
  expect(push).toHaveBeenCalledTimes(1)
  expect(replace).toHaveBeenCalledTimes(0)
  await navigate(new URL('http://localhost/b'), 'replace')
  expect(replace).toHaveBeenCalledTimes(1)
  await navigate(new URL('http://localhost/c'), 'none')
  expect(push).toHaveBeenCalledTimes(1) // unchanged by 'none'
})

test('public navigate() falls back to location.assign when no navigator registered', async () => {
  __resetNavForTest()
  const assign = mock((_url?: string) => {})
  ;(globalThis.location as unknown as Record<string, unknown>).assign = assign
  const { navigate: publicNavigate } = await import('../navigation/navigate.ts')
  await publicNavigate('/fallback', { query: { a: 1 } })
  expect(assign).toHaveBeenCalledTimes(1)
  expect(String(assign.mock.calls[0]![0])).toContain('/fallback?a=1')
})
