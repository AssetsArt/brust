// DOM is not available in bun's default environment. We install happy-dom
// globals in beforeAll so this file is self-contained (no --preload needed).
import { test, expect, beforeAll, beforeEach, mock } from 'bun:test'
import { Window } from 'happy-dom'

// isInternalLink and hydrateMarkersIn are imported lazily (after DOM is up)
// via a module-level variable populated in beforeAll.
let isInternalLink: (a: HTMLAnchorElement, e: MouseEvent) => boolean
let hydrateMarkersIn: (root?: ParentNode) => void
let swapMainContent: (main: HTMLElement, html: string) => void
let hydrateOne: (el: HTMLElement) => Promise<void>
let unmountIslandsIn: (root: ParentNode) => void

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
  ;(win as unknown as Record<string, unknown>).TypeError  = TypeError

  Object.assign(globalThis, {
    document:          win.document,
    window:            win,
    location:          win.location,
    history:           win.history,
    MouseEvent:        win.MouseEvent,
    Event:             win.Event,
    HTMLElement:       win.HTMLElement,
    HTMLAnchorElement: (win as unknown as Record<string, unknown>).HTMLAnchorElement,
    DOMParser:         (win as unknown as Record<string, unknown>).DOMParser,
    // IntersectionObserver intentionally absent — registerTrigger guards with typeof check
    // AbortController is provided natively by bun
  })

  // Import after globals are set so bootstrap's module-level guard
  // (typeof document !== 'undefined') sees the DOM correctly.
  const mod = await import('./bootstrap')
  isInternalLink  = mod.isInternalLink
  hydrateMarkersIn = mod.hydrateMarkersIn
  swapMainContent = mod.swapMainContent
  hydrateOne = mod.hydrateOne
  unmountIslandsIn = mod.unmountIslandsIn
})

function makeLink(href: string, attrs: Partial<{ target: string; download: string; 'data-brust-no-intercept': string }> = {}): HTMLAnchorElement {
  const a = document.createElement('a')
  a.href = href
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined) a.setAttribute(k, v)
  }
  return a
}

function plainClick(): MouseEvent {
  return new MouseEvent('click', { button: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false })
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
  expect(isInternalLink(makeLink('/x', { 'data-brust-no-intercept': '' }), plainClick())).toBe(false)
  expect(isInternalLink(makeLink('/file.pdf', { download: '' }), plainClick())).toBe(false)
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
