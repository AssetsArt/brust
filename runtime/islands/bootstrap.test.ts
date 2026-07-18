// DOM is not available in bun's default environment. We install happy-dom
// globals in beforeAll so this file is self-contained (no --preload needed).
import { test, expect, afterAll, beforeAll, beforeEach, mock } from 'bun:test'
import { Window } from 'happy-dom'
import { getNavState, subscribe, __resetNavForTest } from '../navigation/store.ts'
import { __resetPageCacheForTest, setCachedPage } from './page-cache.ts'

// isInternalLink and hydrateMarkersIn are imported lazily (after DOM is up)
// via a module-level variable populated in beforeAll.
let isInternalLink: (a: HTMLAnchorElement, e: MouseEvent) => boolean
let classifyClick: (
  a: HTMLAnchorElement,
  e: MouseEvent,
) => 'external' | 'hash' | 'reload' | 'navigate'
let hydrateMarkersIn: (root?: ParentNode) => void
let swapMainContent: (main: HTMLElement, html: string) => void
let hydrateOne: (
  el: HTMLElement,
  importer?: (url: string) => Promise<Record<string, unknown>>,
) => Promise<void>
let unmountIslandsIn: (root: ParentNode) => void
let navigate: (url: URL, mode: 'push' | 'replace' | 'none') => Promise<void>
let isFullDocumentPayload: (html: string) => boolean
let prefetchUrlFor: (a: HTMLAnchorElement) => URL | null
let __setCurrentShellForTest: (shell: string | null) => void

// react-dom/client is a STATIC top-level binding in bootstrap.ts, so the mock
// must be registered before `await import('./bootstrap')` runs (below) for it
// to rewire createRoot/hydrateRoot. Spies live at module scope so the
// per-test branch assertions can read call counts; beforeEach clears them so
// one test's calls don't leak into the next ("NOT createRoot" assertions).
const unmountSpy = mock(() => {})
const renderSpy = mock(() => {})
const childCountsAtCreateRoot: number[] = []
const createRootSpy = mock((el: HTMLElement) => {
  childCountsAtCreateRoot.push(el.childNodes.length)
  return { render: renderSpy, unmount: unmountSpy }
})
const hydrateRootSpy = mock(() => ({ unmount: unmountSpy }))

beforeEach(async () => {
  unmountSpy.mockClear()
  renderSpy.mockClear()
  createRootSpy.mockClear()
  hydrateRootSpy.mockClear()
  childCountsAtCreateRoot.length = 0
  // The page cache is module-level state shared across tests in this file —
  // reset so one test's cached navigations don't mask another's fetch asserts.
  __resetPageCacheForTest()
  // Same for the fallback manifest memo (loadFallbackManifest caches forever
  // by design — one test's stubbed routes.json must not leak into the next).
  ;(await import('./fallback.ts')).__resetFallbackForTest()
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
  // Fallback chunk for the client-takeover tests: takeover() dynamic-imports
  // the manifest's chunk URL, which resolves to this mock in-process.
  mock.module('/mock-fb-chunk.js', () => ({
    Component: () => null,
    clientLoader: async () => ({ ok: true }),
  }))

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
  prefetchUrlFor = mod.prefetchUrlFor
  __setCurrentShellForTest = mod.__setCurrentShellForTest
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

test('hydrateOne: client-only placeholder remains while its component module is loading', async () => {
  const el = makeMarker('Deferred', /* csr */ true)
  el.innerHTML = '<span>Loading menu</span>'
  let resolveImport!: (mod: Record<string, unknown>) => void
  const deferredImport = new Promise<Record<string, unknown>>((resolve) => {
    resolveImport = resolve
  })
  const importer = mock(() => deferredImport)

  const pending = hydrateOne(el, importer)
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(importer).toHaveBeenCalledTimes(1)
  expect(el.textContent).toBe('Loading menu')
  expect(createRootSpy).not.toHaveBeenCalled()

  resolveImport({ default: () => null })
  await pending
})

test('hydrateOne: client-only marker (data-brust-csr) uses createRoot+render, NOT hydrateRoot', async () => {
  const el = makeMarker('Counter', /* csr */ true)
  await hydrateOne(el)
  expect(createRootSpy).toHaveBeenCalledTimes(1)
  expect(createRootSpy).toHaveBeenCalledWith(el)
  expect(renderSpy).toHaveBeenCalledTimes(1)
  expect(hydrateRootSpy).not.toHaveBeenCalled()
})

test('hydrateOne: successful client-only takeover clears placeholder immediately before createRoot', async () => {
  const el = makeMarker('Menu', /* csr */ true)
  el.innerHTML = '<span>Loading menu</span>'

  await hydrateOne(el, async () => ({ default: () => null }))

  expect(childCountsAtCreateRoot).toEqual([0])
  expect(el.childNodes).toHaveLength(0)
})

test('hydrateOne: rejected client-only import preserves placeholder', async () => {
  const el = makeMarker('BrokenMenu', /* csr */ true)
  el.innerHTML = '<span>Menu unavailable</span>'

  await hydrateOne(el, async () => {
    throw new Error('chunk failed')
  })

  expect(el.textContent).toBe('Menu unavailable')
  expect(el.childNodes).toHaveLength(1)
  expect(createRootSpy).not.toHaveBeenCalled()
})

test('hydrateOne: invalid client-only component preserves placeholder', async () => {
  const el = makeMarker('InvalidMenu', /* csr */ true)
  el.innerHTML = '<span>Menu unavailable</span>'

  await hydrateOne(el, async () => ({ default: { not: 'a component' } }))

  expect(el.textContent).toBe('Menu unavailable')
  expect(el.childNodes).toHaveLength(1)
  expect(createRootSpy).not.toHaveBeenCalled()
})

test('hydrateOne: server marker (no data-brust-csr) uses hydrateRoot, NOT createRoot', async () => {
  const el = makeMarker('Server', /* csr */ false)
  el.innerHTML = '<button>Server menu</button>'
  await hydrateOne(el)
  expect(hydrateRootSpy).toHaveBeenCalledTimes(1)
  expect(hydrateRootSpy).toHaveBeenCalledWith(el, expect.anything())
  expect(createRootSpy).not.toHaveBeenCalled()
  expect(renderSpy).not.toHaveBeenCalled()
  expect(el.textContent).toBe('Server menu')
  expect(el.childNodes).toHaveLength(1)
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

test('navigate() serves a revisited page from the in-memory cache (no refetch)', async () => {
  __resetNavForTest()
  document.body.innerHTML = '<main></main>'
  const fetchSpy = mock(async (input: unknown) => {
    const path = String(input)
    return {
      ok: true,
      json: async () => ({ html: `<p>page:${path}</p>`, title: 'T' }),
    }
  })
  ;(globalThis as Record<string, unknown>).fetch = fetchSpy
  await navigate(new URL('http://localhost/cache-a'), 'push')
  expect(fetchSpy).toHaveBeenCalledTimes(1)
  await navigate(new URL('http://localhost/cache-b'), 'push')
  expect(fetchSpy).toHaveBeenCalledTimes(2)
  // Revisit /cache-a: swapped from cache, NO third fetch.
  await navigate(new URL('http://localhost/cache-a'), 'push')
  expect(fetchSpy).toHaveBeenCalledTimes(2)
  expect(document.querySelector('main')!.textContent).toContain('/_brust/page/cache-a')
  expect(getNavState().path).toBe('/cache-a')
  expect(getNavState().phase).toBe('success')
})

test('navigate() does NOT re-apply the store snapshot when serving from cache', async () => {
  __resetNavForTest()
  document.body.innerHTML = '<main></main>'
  const setSpy = mock((_v: unknown) => {})
  ;(window as unknown as Record<string, unknown>).__BRUST_STORES__ = {
    counter: { instance: { n: { set: setSpy } } },
  }
  try {
    // Only /snap carries a snapshot — otherwise the /elsewhere hop would
    // legitimately apply its own (fresh) snapshot and muddy the count.
    ;(globalThis as Record<string, unknown>).fetch = mock(async (input: unknown) => ({
      ok: true,
      json: async () =>
        String(input).includes('/snap')
          ? { html: '<p>snap</p>', title: 'T', store: { counter: { n: 1 } } }
          : { html: '<p>other</p>', title: 'T' },
    }))
    await navigate(new URL('http://localhost/snap'), 'push')
    expect(setSpy).toHaveBeenCalledTimes(1) // fresh payload applies the snapshot
    await navigate(new URL('http://localhost/elsewhere'), 'push')
    await navigate(new URL('http://localhost/snap'), 'push')
    // Cached replay must NOT roll live client store state back to the stale snapshot.
    expect(setSpy).toHaveBeenCalledTimes(1)
  } finally {
    delete (window as unknown as Record<string, unknown>).__BRUST_STORES__
  }
})

test('popstate (mode none) reuses a cached entry regardless of age', async () => {
  __resetNavForTest()
  document.body.innerHTML = '<main></main>'
  const fetchSpy = mock(async () => ({
    ok: true,
    json: async () => ({ html: '<p>fresh</p>', title: 'T' }),
  }))
  ;(globalThis as Record<string, unknown>).fetch = fetchSpy
  // Seed an entry that is far past PAGE_STALE_MS for forward navs.
  setCachedPage('/old', { html: '<p>ancient</p>', title: 'Old' })
  const entry = (await import('./page-cache.ts')).getCachedPage('/old', Number.POSITIVE_INFINITY)
  expect(entry).not.toBeNull()
  await navigate(new URL('http://localhost/old'), 'none')
  expect(fetchSpy).toHaveBeenCalledTimes(0)
  expect(document.querySelector('main')!.textContent).toContain('ancient')
})

test('prefetchUrlFor accepts internal links; rejects opt-outs, externals, and the current page', () => {
  expect(prefetchUrlFor(makeLink('/docs/intro'))?.pathname).toBe('/docs/intro')
  expect(prefetchUrlFor(makeLink('https://example.com/x'))).toBeNull()
  expect(prefetchUrlFor(makeLink('/docs/intro', { target: '_blank' }))).toBeNull()
  expect(prefetchUrlFor(makeLink('/docs/intro', { download: '' }))).toBeNull()
  expect(prefetchUrlFor(makeLink('/docs/intro', { 'data-brust-no-intercept': '' }))).toBeNull()
  expect(prefetchUrlFor(makeLink('/_brust/islands/x.js'))).toBeNull()
  const noPrefetch = makeLink('/docs/intro')
  noPrefetch.setAttribute('data-brust-no-prefetch', '')
  expect(prefetchUrlFor(noPrefetch)).toBeNull()
  // The page we're already on (earlier navigate tests pushState'd away from
  // "/", so resolve the CURRENT location instead of hardcoding it).
  expect(prefetchUrlFor(makeLink(location.pathname + location.search))).toBeNull()
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

// ----- fallback: 'client' takeover wiring (Task B6) -------------------------

/** Fetch stub for the takeover tests: every /_brust/page/* 404s (static-host
 * miss) except the paths in `okPages`; routes.json serves a one-entry
 * manifest (or 404s when `manifest` is false); the fallback payload URL
 * serves the placeholder shell. */
function fallbackFetchStub(opts: { manifest: boolean; okPages?: string[] }) {
  return mock(async (input: unknown) => {
    const path = String(input)
    if (path === '/_brust/routes.json') {
      if (!opts.manifest) return { ok: false, status: 404 }
      return {
        ok: true,
        json: async () => ({
          version: 1,
          fallbacks: [
            {
              pattern: '/fb/{id}',
              doc: '/_brust/fallback/fb/__id__/',
              payload: '/_brust/fallback-page/fb/__id__/',
              chunk: '/mock-fb-chunk.js',
            },
          ],
        }),
      }
    }
    if (path === '/_brust/fallback-page/fb/__id__/') {
      return {
        ok: true,
        json: async () => ({
          html: '<div data-brust-fallback-root data-brust-fallback="/fb/{id}"></div>',
          title: 'FB',
        }),
      }
    }
    for (const ok of opts.okPages ?? []) {
      if (path === `/_brust/page${ok}`) {
        return {
          ok: true,
          json: async () => ({ html: `<p>page:${ok}</p>`, title: 'OK' }),
        }
      }
    }
    return { ok: false, status: 404 }
  })
}

/** Earlier navigate-mode tests shadow history.pushState/replaceState with
 * own-property mocks and never restore them. The takeover path needs the
 * REAL happy-dom pushState (takeover derives params from location.pathname,
 * which only the real implementation updates) — deleting the shadows
 * re-exposes the prototype methods. */
function restoreRealHistory(): void {
  Reflect.deleteProperty(globalThis.history, 'pushState')
  Reflect.deleteProperty(globalThis.history, 'replaceState')
}

test('navigate() falls back to client takeover when the payload 404s and a fallback pattern matches', async () => {
  __resetNavForTest()
  restoreRealHistory()
  document.body.innerHTML = '<main></main>'
  ;(globalThis as Record<string, unknown>).fetch = fallbackFetchStub({ manifest: true })
  await navigate(new URL('http://localhost/fb/x'), 'push')
  // The placeholder shell was swapped into <main> (no full reload)…
  expect(document.querySelector('main [data-brust-fallback-root]')).not.toBeNull()
  expect(document.title).toBe('FB')
  // …the URL committed to the requested path with phase success…
  expect(getNavState().phase).toBe('success')
  expect(getNavState().path).toBe('/fb/x')
  expect(location.pathname).toBe('/fb/x')
  // …and takeover client-rendered through the module-wide createRoot mock.
  expect(createRootSpy).toHaveBeenCalledTimes(1)
  expect(renderSpy).toHaveBeenCalledTimes(1)
})

test('navigate() full-reloads (existing behavior) when payload 404s and NO manifest', async () => {
  __resetNavForTest()
  restoreRealHistory()
  document.body.innerHTML = '<main></main>'
  ;(globalThis as Record<string, unknown>).fetch = fallbackFetchStub({ manifest: false })
  await navigate(new URL('http://localhost/fb/missing'), 'push')
  // No manifest match → the original fetch error reaches the existing catch:
  // __navError fires and the navigator assigns location.href (full reload —
  // happy-dom records the URL without actually navigating).
  expect(getNavState().phase).toBe('error')
  expect(location.href).toBe('http://localhost/fb/missing')
  expect(createRootSpy).not.toHaveBeenCalled()
})

// ----- Task 6 (Part A): SPA renders a 404-with-body in-place ----------------

test('navigate(): a 404 carrying a JSON page payload swaps content + title (store:null), no full reload, not cached', async () => {
  __resetNavForTest()
  restoreRealHistory()
  document.body.innerHTML = '<main>old</main>'
  // Track location.href writes (a full reload would set it).
  const hrefBefore = location.href
  const fetchSpy = mock(async () => ({
    ok: false,
    status: 404,
    json: async () => ({ html: '<p>not found page</p>', title: '404', store: null }),
  }))
  ;(globalThis as Record<string, unknown>).fetch = fetchSpy
  await navigate(new URL('http://localhost/nope'), 'push')
  // Content + title swapped in-place; store:null must NOT throw applyStoreSnapshot.
  expect(document.querySelector('main')!.textContent).toContain('not found page')
  expect(document.title).toBe('404')
  expect(getNavState().phase).toBe('success')
  // No full reload — location.href is unchanged except the pushState path update.
  expect(location.href).not.toBe(hrefBefore) // pushState moved us to /nope
  expect(location.pathname).toBe('/nope')
  expect(fetchSpy).toHaveBeenCalledTimes(1)
  // The 404 payload must NOT be cached — a re-navigation refetches it.
  await navigate(new URL('http://localhost/nope'), 'push')
  expect(fetchSpy).toHaveBeenCalledTimes(2)
})

test('navigate(): a 5xx still full-reloads (transport failure, not a renderable 404)', async () => {
  __resetNavForTest()
  restoreRealHistory()
  document.body.innerHTML = '<main></main>'
  ;(globalThis as Record<string, unknown>).fetch = mock(async () => ({
    ok: false,
    status: 500,
    json: async () => ({ html: '<p>err</p>', title: 'E' }),
  }))
  await navigate(new URL('http://localhost/boom'), 'push')
  expect(getNavState().phase).toBe('error')
  expect(location.href).toBe('http://localhost/boom')
})

test('navigate(): a network error still full-reloads', async () => {
  __resetNavForTest()
  restoreRealHistory()
  document.body.innerHTML = '<main></main>'
  ;(globalThis as Record<string, unknown>).fetch = mock(async () => {
    throw new Error('network down')
  })
  await navigate(new URL('http://localhost/down'), 'push')
  expect(getNavState().phase).toBe('error')
  expect(location.href).toBe('http://localhost/down')
})

test('navigate(): a 404 with an empty/non-JSON body still full-reloads', async () => {
  __resetNavForTest()
  restoreRealHistory()
  document.body.innerHTML = '<main></main>'
  ;(globalThis as Record<string, unknown>).fetch = mock(async () => ({
    ok: false,
    status: 404,
    json: async () => {
      throw new Error('Unexpected end of JSON input')
    },
  }))
  await navigate(new URL('http://localhost/empty404'), 'push')
  expect(getNavState().phase).toBe('error')
  expect(location.href).toBe('http://localhost/empty404')
})

// --- SPA shell signature: full-load on layout-chain change (Task 4) ---

test('navigate(): payload.shell ≠ currentShell → full document load, no swap', async () => {
  __resetNavForTest()
  restoreRealHistory()
  __setCurrentShellForTest('L:AppLayout')
  document.body.innerHTML = '<main><p>original</p></main>'
  ;(globalThis as Record<string, unknown>).fetch = mock(async () => ({
    ok: true,
    json: async () => ({ html: '<p>login card</p>', title: 'Login', shell: 'S:LoginPage' }),
  }))
  await navigate(new URL('http://localhost/login'), 'push')
  // Shell changed → authoritative full load (location.href set); <main> untouched.
  expect(location.href).toBe('http://localhost/login')
  expect(document.querySelector('main')!.textContent).toContain('original')
  __setCurrentShellForTest(null)
})

test('navigate(): payload.shell === currentShell → fast in-place swap', async () => {
  __resetNavForTest()
  restoreRealHistory()
  __setCurrentShellForTest('L:AppLayout')
  document.body.innerHTML = '<main><p>original</p></main>'
  ;(globalThis as Record<string, unknown>).fetch = mock(async () => ({
    ok: true,
    json: async () => ({ html: '<p>settings</p>', title: 'Settings', shell: 'L:AppLayout' }),
  }))
  await navigate(new URL('http://localhost/settings'), 'push')
  // Same shell → swap, NO full load.
  expect(document.querySelector('main')!.textContent).toContain('settings')
  expect(getNavState().path).toBe('/settings')
  expect(getNavState().phase).toBe('success')
  __setCurrentShellForTest(null)
})

test('navigate(): payload without shell → fall through to existing swap (backward-safe)', async () => {
  __resetNavForTest()
  restoreRealHistory()
  __setCurrentShellForTest('L:AppLayout')
  document.body.innerHTML = '<main><p>original</p></main>'
  ;(globalThis as Record<string, unknown>).fetch = mock(async () => ({
    ok: true,
    json: async () => ({ html: '<p>no-shell payload</p>', title: 'T' }),
  }))
  await navigate(new URL('http://localhost/legacy'), 'push')
  // No payload.shell → never over-full-load; existing swap runs.
  expect(document.querySelector('main')!.textContent).toContain('no-shell payload')
  expect(getNavState().phase).toBe('success')
  __setCurrentShellForTest(null)
})

test('navigate(): no currentShell meta → fall through to existing swap even on differing payload.shell', async () => {
  __resetNavForTest()
  restoreRealHistory()
  __setCurrentShellForTest(null)
  document.body.innerHTML = '<main><p>original</p></main>'
  ;(globalThis as Record<string, unknown>).fetch = mock(async () => ({
    ok: true,
    json: async () => ({ html: '<p>swapped anyway</p>', title: 'T', shell: 'S:Whatever' }),
  }))
  await navigate(new URL('http://localhost/anything'), 'push')
  // currentShell absent (stale boot doc) → both-present guard fails → swap.
  expect(document.querySelector('main')!.textContent).toContain('swapped anyway')
  expect(getNavState().phase).toBe('success')
})

test('navigate(): cache-hit with a differing shell → full load', async () => {
  __resetNavForTest()
  restoreRealHistory()
  __setCurrentShellForTest('L:AppLayout')
  document.body.innerHTML = '<main><p>original</p></main>'
  // Seed the cache directly so navigate() takes the cache path (no fetch).
  setCachedPage('/cached-cross', {
    html: '<p>cached cross-shell</p>',
    title: 'X',
    shell: 'S:Other',
  })
  await navigate(new URL('http://localhost/cached-cross'), 'push')
  expect(location.href).toBe('http://localhost/cached-cross')
  expect(document.querySelector('main')!.textContent).toContain('original')
  __setCurrentShellForTest(null)
})

test('unmountIslandsIn delegates to unmountFallbackRootsIn (navigating away disposes the client root)', async () => {
  __resetNavForTest()
  restoreRealHistory()
  document.body.innerHTML = '<main></main>'
  ;(globalThis as Record<string, unknown>).fetch = fallbackFetchStub({
    manifest: true,
    okPages: ['/plain'],
  })
  await navigate(new URL('http://localhost/fb/y'), 'push')
  expect(document.querySelector('main [data-brust-fallback-root]')).not.toBeNull()
  expect(createRootSpy).toHaveBeenCalledTimes(1)
  expect(unmountSpy).not.toHaveBeenCalled()
  // Navigating away swaps <main>; unmountIslandsIn must dispose the takeover
  // root via unmountFallbackRootsIn or React keeps scheduling on dead nodes.
  await navigate(new URL('http://localhost/plain'), 'push')
  expect(unmountSpy).toHaveBeenCalledTimes(1)
  expect(document.querySelector('main [data-brust-fallback-root]')).toBeNull()
  expect(getNavState().path).toBe('/plain')
  expect(getNavState().phase).toBe('success')
})
