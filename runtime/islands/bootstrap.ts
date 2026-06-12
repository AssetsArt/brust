// Brust client-side hydration bootstrap.
// Built once at boot into .brust/islands/_bootstrap.js and served at
// /_brust/islands/_bootstrap.js. Loaded by makeRenderer-injected <script>.
//
// Responsibilities:
//   1. Hydrate every <... data-brust-island="<id>" ...> marker under a
//      given root (default: document.body) — exposed as hydrateMarkersIn
//      so the navigation interceptor can re-run it on the new <main>
//      after a navigation swap.
//   2. Intercept internal <a href> clicks → fetch /_brust/page/{path} →
//      swap <main> in place → update title → re-hydrate islands →
//      history.pushState. Any failure falls back to a full reload.
//   3. Listen for popstate (back / forward) and run the same swap path
//      without pushing a new entry.

import { createRoot, hydrateRoot, type Root } from 'react-dom/client'
import { createElement } from 'react'
import { applyStoreSnapshot } from '../store/client-hydrate.ts'
import {
  __navStart,
  __navCommit,
  __navError,
  __navInit,
  registerNavigator,
} from '../navigation/store.ts'
import { installActiveNav } from '../navigation/active-nav.ts'
import {
  pageCacheKey,
  getCachedPage,
  fetchPagePayload,
  inflightPage,
  prefetchPage,
  type PagePayload,
} from './page-cache.ts'
import {
  matchFallback,
  loadFallbackManifest,
  takeover,
  unmountFallbackRootsIn,
} from './fallback.ts'
import { withViewTransition } from './view-transition.ts'

// Track React roots created by hydrateOne so we can unmount them before
// removing their DOM in swapMainContent. Without this, removing the DOM
// out from under a live root causes React's scheduler to keep posting
// work to a detached subtree, which manifests as a hung tab.
const islandRoots = new WeakMap<HTMLElement, Root>()

type Trigger = 'load' | 'idle' | 'visible' | 'interaction'

function registerTrigger(el: HTMLElement, trigger: Trigger, fire: () => void): void {
  switch (trigger) {
    case 'load': {
      fire()
      return
    }
    case 'idle': {
      const rIC = (globalThis as { requestIdleCallback?: (cb: () => void) => void })
        .requestIdleCallback
      if (typeof rIC === 'function') {
        rIC(fire)
      } else {
        setTimeout(fire, 0)
      }
      return
    }
    case 'visible': {
      if (typeof IntersectionObserver === 'undefined') {
        fire()
        return
      }
      const io = new IntersectionObserver((entries, obs) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            obs.disconnect()
            fire()
            return
          }
        }
      })
      io.observe(el)
      return
    }
    case 'interaction': {
      const onceFire = () => {
        el.removeEventListener('pointerdown', onceFire)
        el.removeEventListener('keydown', onceFire)
        el.removeEventListener('focusin', onceFire)
        fire()
      }
      el.addEventListener('pointerdown', onceFire, { once: false })
      el.addEventListener('keydown', onceFire, { once: false })
      el.addEventListener('focusin', onceFire, { once: false })
      return
    }
  }
}

// Exported for unit testing — the public entry is hydrateMarkersIn, but the
// createRoot/hydrateRoot auto-detect branch is cleanest to assert by driving
// hydrateOne directly (the `load` trigger fires it as a detached microtask).
// id → content-addressed chunk URL, emitted by buildIslands as _islands.js.
// Loaded once (memoized). On any failure the map is empty and resolution falls
// back to the legacy `/_brust/islands/<id>.js` URL, so an older build still works.
let chunkMapPromise: Promise<Record<string, string>> | null = null
function islandChunkMap(): Promise<Record<string, string>> {
  if (!chunkMapPromise) {
    const url = '/_brust/islands/_islands.js' // variable specifier → runtime import, not bundled
    chunkMapPromise = import(url)
      .then((m) => (m.default ?? {}) as Record<string, string>)
      .catch(() => ({}))
  }
  return chunkMapPromise
}

export async function hydrateOne(el: HTMLElement): Promise<void> {
  const id = el.getAttribute('data-brust-island')
  if (!id) return
  const propsJson = el.getAttribute('data-brust-props') ?? '{}'
  let props: Record<string, unknown>
  try {
    props = JSON.parse(propsJson)
  } catch (e) {
    console.error(`[brust] island "${id}": invalid data-brust-props JSON`, e)
    return
  }
  try {
    const url = (await islandChunkMap())[id] ?? `/_brust/islands/${id}.js`
    const mod = await import(url)
    const Component = (mod.default ?? mod) as React.ComponentType<Record<string, unknown>>
    if (typeof Component !== 'function') {
      console.error(`[brust] island "${id}": chunk has no default-exported component`)
      return
    }
    let root: Root
    if (el.hasAttribute('data-brust-csr')) {
      // Client-only island: the native compiler emits an EMPTY mount (no
      // server markup) tagged data-brust-csr. hydrateRoot on an empty mount
      // is a React 19 hydration mismatch, so spin up a fresh client root.
      root = createRoot(el)
      root.render(createElement(Component, props))
    } else {
      // Server island (or React-path island): server markup is present in the
      // mount, so hydrate it in place to attach handlers without re-rendering.
      root = hydrateRoot(el, createElement(Component, props))
    }
    // createRoot and hydrateRoot both return a Root with .unmount(), so
    // islandRoots / unmountIslandsIn handle either uniformly — no extra work.
    islandRoots.set(el, root)
  } catch (e) {
    console.error(`[brust] island "${id}": hydration failed`, e)
  }
}

/** Unmount any React roots that live inside `root`. Must run BEFORE
 * removing or replacing their DOM, otherwise React's scheduler keeps
 * posting work to detached nodes and the tab hangs. Exported for unit
 * testing the createRoot/hydrateRoot unmount parity. */
export function unmountIslandsIn(root: ParentNode): void {
  const markers = root.querySelectorAll<HTMLElement>('[data-brust-island]')
  for (const el of Array.from(markers)) {
    const r = islandRoots.get(el)
    if (r) {
      try {
        r.unmount()
      } catch (e) {
        console.warn('[brust] island unmount failed', e)
      }
      islandRoots.delete(el)
    }
  }
  // Client-takeover roots (fallback: 'client' SSG pages) live in fallback.ts's
  // own WeakMap — delegate so navigating away from a client-rendered page
  // disposes its React root too (same detached-root hazard as islands).
  unmountFallbackRootsIn(root)
}

/** Scan `root` for un-hydrated island markers and register their hydration
 * triggers. Exposed so the navigation interceptor can call it on the
 * freshly-swapped <main> subtree after a SPA navigation. The
 * `data-brust-hydrated` attribute on each marker is the idempotence guard
 * — a second call on the same root no-ops for already-hydrated markers. */
export function hydrateMarkersIn(root: ParentNode = document.body): void {
  const markers = root.querySelectorAll<HTMLElement>(
    '[data-brust-island]:not([data-brust-hydrated])',
  )
  for (const el of Array.from(markers)) {
    el.setAttribute('data-brust-hydrated', '1')
    const trig = (el.getAttribute('data-brust-hydrate') ?? 'load') as Trigger
    registerTrigger(el, trig, () => {
      void hydrateOne(el)
    })
  }
}

/** Replace `main`'s children with HTML from a trusted Brust server
 * response. The trust boundary: the HTML originates from the same Brust
 * server that produced the initial page load. We use DOMParser (not
 * Range.createContextualFragment) because DOMParser produces an INERT
 * document — <script> tags are parsed but never executed. */
export function swapMainContent(main: HTMLElement, html: string): void {
  const parsed = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  while (main.firstChild) main.removeChild(main.firstChild)
  // Snapshot children before iterating: importNode clones (does NOT remove
  // from source), so iterating on parsed.body.firstChild directly would
  // infinite-loop. Array.from gives a fixed-length live snapshot to walk.
  for (const node of Array.from(parsed.body.childNodes)) {
    main.appendChild(document.importNode(node, true))
  }
}

/** What a left-click on an <a> means for in-app navigation. Exported for unit
 * testing.
 *   - 'external': not ours (cross-origin, modifier/middle click, target,
 *     download, opt-out, /_brust/) — leave the browser alone.
 *   - 'hash':     same path+query, different hash — let the browser scroll
 *     natively (do NOT preventDefault).
 *   - 'reload':   the exact current URL — the browser would full-reload, so we
 *     claim the click (preventDefault) and no-op. This is the active menu item.
 *   - 'navigate': a different in-app page — SPA fetch + swap. */
export function classifyClick(
  a: HTMLAnchorElement,
  event: MouseEvent,
): 'external' | 'hash' | 'reload' | 'navigate' {
  if (event.defaultPrevented) return 'external'
  if (event.button !== 0) return 'external'
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return 'external'
  if (a.target && a.target !== '_self') return 'external'
  if (a.hasAttribute('download')) return 'external'
  if (a.dataset.brustNoIntercept !== undefined) return 'external'
  const url = new URL(a.href, location.href)
  if (url.origin !== location.origin) return 'external'
  if (url.pathname.startsWith('/_brust/')) return 'external'
  if (url.pathname === location.pathname && url.search === location.search) {
    // Same page: a differing hash is a native in-page scroll (don't intercept);
    // an identical URL would otherwise trigger a browser full reload, so we
    // claim it and no-op instead of refetching.
    return url.hash !== location.hash ? 'hash' : 'reload'
  }
  return 'navigate'
}

/** Back-compat thin wrapper — true iff the click is an SPA navigation. */
export function isInternalLink(a: HTMLAnchorElement, event: MouseEvent): boolean {
  return classifyClick(a, event) === 'navigate'
}

/** True iff a navigation payload is a FULL HTML document rather than the inner
 * `<main>` content of a shared shell. A standalone route (one that renders its
 * own `<html>` with no `<main>`) ships its whole document here — see the no-main
 * contract in routes.ts navigationBranch. Such a payload CANNOT be swapped into
 * the current shell's `<main>` (it would nest a second document inside the live
 * chrome — duplicate topbar/sidebar). The navigator falls back to a full load.
 *
 * Inner `<main>` content is the element's children and can never begin with
 * `<html>`/`<!doctype>`, so this prefix sniff has no false positives. */
export function isFullDocumentPayload(html: string): boolean {
  const head = html.trimStart().slice(0, 16).toLowerCase()
  return head.startsWith('<!doctype') || head.startsWith('<html')
}

let inFlight: AbortController | null = null

// scrollY of each page we navigated away from (keyed pathname+search), so
// back/forward restores the reading position instead of jumping to top.
const scrollPositions = new Map<string, number>()
// The page currently in the DOM. Tracked here (set at boot + on every commit)
// instead of read from `location` at save time, because popstate updates
// `location` to the DESTINATION before the event fires — reading it there
// would record the leaving page's scroll under the wrong key.
let currentPageKey = ''

/** SPA-navigate onto a `fallback: 'client'` SSG route on a static host.
 *
 * Called from navigate() when the normal payload fetch fails: a
 * non-prerendered dynamic path has no `/_brust/page/...` file on a static
 * host, so the fetch 404s. Match the path against the export's fallback
 * manifest, fetch the route's placeholder-shell payload from the manifest's
 * `payload` URL (`/_brust/fallback-page/...` — the only payload that exists
 * for such a path on a static host), swap it into `<main>` with the SAME
 * post-swap sequence the normal path uses, then client-render the real page
 * via takeover().
 *
 * The payload is intentionally NOT stored in the page cache: client-rendered
 * data must be fresh per visit (clientLoader owns freshness), and replaying
 * the bare placeholder shell would be useless anyway.
 *
 * Returns false when this navigation cannot be handled here (no manifest
 * match, payload missing/invalid, no `<main>`) — the caller rethrows into
 * the existing full-reload fallback. Supersession (the AbortController was
 * aborted by a newer navigation) also returns false WITHOUT touching the DOM
 * or committing; the caller checks `signal.aborted` before rethrowing. */
async function attemptClientFallback(
  url: URL,
  mode: 'push' | 'replace' | 'none',
  signal?: AbortSignal,
): Promise<boolean> {
  const entries = await loadFallbackManifest()
  const entry = entries.find((e) => matchFallback(e.pattern, url.pathname) !== null)
  if (!entry) return false
  let html: string
  let title: string | undefined
  try {
    const resp = await fetch(entry.payload, { headers: { Accept: 'application/json' } })
    if (!resp.ok) return false
    const payload = (await resp.json()) as { html?: unknown; title?: unknown }
    if (typeof payload.html !== 'string') return false
    html = payload.html
    title = typeof payload.title === 'string' ? payload.title : undefined
  } catch {
    return false
  }
  // Superseded while fetching → a newer navigation owns the DOM; do nothing.
  if (signal?.aborted) return false
  // Same full-document guard as the normal path: a standalone-route shell
  // cannot be swapped into the current <main> — authoritative full load.
  if (isFullDocumentPayload(html)) {
    location.href = url.href
    return true
  }
  const main = document.querySelector('main')
  if (!main) return false
  // From here down: the SAME post-swap sequence navigate()'s normal path runs.
  scrollPositions.set(currentPageKey, window.scrollY)
  await withViewTransition(document, () => {
    unmountIslandsIn(main as HTMLElement)
    swapMainContent(main as HTMLElement, html)
    if (title) document.title = title
    // History BEFORE takeover: takeover derives params from location.pathname,
    // so the URL bar must already show the destination.
    if (mode === 'push') history.pushState({}, '', url.href)
    else if (mode === 'replace') history.replaceState({}, '', url.href)
    if (mode === 'none') window.scrollTo(0, scrollPositions.get(pageCacheKey(url)) ?? 0)
    else window.scrollTo(0, 0)
    currentPageKey = pageCacheKey(url)
  })
  // Superseded across the view-transition await → the newer navigation owns
  // the DOM; don't run takeover/hydrate/commit on a soon-to-be-replaced shell.
  if (signal?.aborted) return true
  const container = main.querySelector<HTMLElement>('[data-brust-fallback-root]')
  if (!container) {
    // A fallback payload without its marker is a build bug — log it, but
    // commit the swap so navigation doesn't brick (the shell IS on screen).
    console.warn(
      '[brust] fallback payload has no [data-brust-fallback-root] marker — client takeover skipped',
    )
    hydrateMarkersIn(main as HTMLElement)
    __navCommit(url.pathname, url.search)
    return true
  }
  // Superseded while the payload was loading → the newer navigation owns the
  // DOM from here; handing the container to takeover would let its render
  // land in a subtree the newer swap is about to (or already did) remove.
  if (signal?.aborted) return true
  // ORDER: takeover BEFORE hydrateMarkersIn. The container was JUST swapped
  // in, so nothing inside it is hydrated yet; hydrating first would register
  // placeholder-island triggers whose async mounts race takeover's child
  // removal (a live root on removed DOM hangs the tab). Running takeover
  // first means the container's children are either removed before any
  // trigger is registered (success) or hydrated exactly once afterwards
  // (failure keeps the placeholder, which then becomes interactive). Either
  // way a placeholder island can never double-mount.
  // takeover gets the SIGNAL so a supersession mid-clientLoader can't mount
  // a React root into a container the newer navigation already detached.
  await takeover(container, signal)
  // Superseded during takeover → skip hydration/commit; the newer navigation
  // owns the DOM and the nav store from here.
  if (signal?.aborted) return true
  hydrateMarkersIn(main as HTMLElement)
  // Commit only after takeover resolves: phase 'loading' covers the client
  // data fetch, so NavPreloader stays honest about in-flight work.
  __navCommit(url.pathname, url.search)
  return true
}

export async function navigate(url: URL, mode: 'push' | 'replace' | 'none'): Promise<void> {
  inFlight?.abort()
  const ac = new AbortController()
  inFlight = ac
  try {
    __navStart(url.pathname, url.search)
    const key = pageCacheKey(url)
    // Visited pages are served from the in-memory cache — no refetch. Forward
    // navigations respect PAGE_STALE_MS (default max age); back/forward reuses
    // any entry regardless of age, like the browser's bfcache.
    const cached = getCachedPage(key, mode === 'none' ? Number.POSITIVE_INFINITY : undefined)
    let payload: PagePayload
    if (cached) {
      payload = cached
    } else {
      try {
        // A hover prefetch may already have this page in flight — await it
        // instead of double-fetching; if it failed, fall back to a direct fetch.
        const pre = inflightPage(key)
        if (pre) {
          try {
            payload = await pre
          } catch {
            payload = await fetchPagePayload(url, ac.signal)
          }
        } else {
          payload = await fetchPagePayload(url, ac.signal)
        }
      } catch (err) {
        // Static-host miss: a non-prerendered `fallback: 'client'` path has
        // no payload file, so the fetch 404s. Try the client takeover before
        // the full-reload fallback. Abort keeps its existing meaning
        // (supersession) and must reach the outer catch untouched.
        if ((err as Error).name === 'AbortError') throw err
        if (await attemptClientFallback(url, mode, ac.signal)) return
        // Superseded during the fallback attempt → a newer navigation owns
        // the DOM; bail without committing OR full-reloading.
        if (ac.signal.aborted) return
        throw err
      }
      // The prefetch promise isn't tied to our AbortController, so an abort
      // during that await doesn't throw — check for supersession explicitly.
      if (ac.signal.aborted) return
    }
    const { html, title, store } = payload
    // A standalone (no-<main>) route ships its FULL document here. We can't swap
    // that into the current shell's <main> without nesting a second document
    // (duplicate chrome — the classic two-topbars artifact), and the current
    // document's own <main> existence can't tell us the TARGET has one. Detect
    // the full-document payload and fall back to the authoritative full load.
    if (isFullDocumentPayload(html)) {
      location.href = url.href
      return
    }
    const main = document.querySelector('main')
    if (!main) throw new Error('navigation: no <main> element')
    // scrollY of the LEAVING page is read before the transition (it must see
    // the old page's position under the old key).
    scrollPositions.set(currentPageKey, window.scrollY)
    await withViewTransition(document, () => {
      unmountIslandsIn(main as HTMLElement)
      swapMainContent(main as HTMLElement, html)
      // Only a FRESH payload re-applies the server store snapshot: replaying a
      // cached (stale) snapshot would roll back live client store state the
      // user changed since the page was first fetched.
      if (!cached && store) applyStoreSnapshot(store)
      if (title) document.title = title
      if (mode === 'push') history.pushState({}, '', url.href)
      else if (mode === 'replace') history.replaceState({}, '', url.href)
      if (mode === 'none') window.scrollTo(0, scrollPositions.get(key) ?? 0)
      else window.scrollTo(0, 0)
      hydrateMarkersIn(main as HTMLElement)
    })
    // The view-transition await is a new suspension point: a newer navigation
    // could have aborted us between the swap and here. The DOM is already
    // committed (irreversible), but skip the bookkeeping so we don't advance
    // the nav store to this stale destination — the newer navigation owns it.
    if (ac.signal.aborted) return
    currentPageKey = key
    __navCommit(url.pathname, url.search)
  } catch (err) {
    if ((err as Error).name === 'AbortError') return
    __navError(url.pathname, err)
    console.warn('[brust] SPA navigation failed, falling back to full reload:', err)
    location.href = url.href
  } finally {
    if (inFlight === ac) inFlight = null
  }
}

/** Resolve an <a> to a prefetchable in-app URL, or null when prefetch must not
 * run: not ours (cross-origin, target, download, /_brust/), explicitly opted
 * out (data-brust-no-intercept disables SPA handling entirely;
 * data-brust-no-prefetch keeps the SPA click but skips the speculative fetch),
 * or the page we are already on. Exported for unit testing. */
export function prefetchUrlFor(a: HTMLAnchorElement): URL | null {
  if (a.target && a.target !== '_self') return null
  if (a.hasAttribute('download')) return null
  if (a.dataset.brustNoIntercept !== undefined) return null
  if (a.dataset.brustNoPrefetch !== undefined) return null
  if (!a.getAttribute('href')) return null
  const url = new URL(a.href, location.href)
  if (url.origin !== location.origin) return null
  if (url.pathname.startsWith('/_brust/')) return null
  if (url.pathname === location.pathname && url.search === location.search) return null
  return url
}

// Hover-intent delay: long enough that a cursor sweeping across a nav list
// doesn't fire a fetch per link, short enough to beat the click (~200-300ms
// between hover and press for a deliberate click).
const HOVER_DELAY_MS = 80

/** Hover/touch prefetch: pointer rests on an internal link for HOVER_DELAY_MS
 * (or a touch starts — the tap commits within ~100ms anyway) → fetch its nav
 * payload into the page cache so the eventual click swaps instantly.
 * prefetchPage dedupes in-flight fetches and respects Save-Data/2g. */
function installPrefetch(): void {
  const timers = new WeakMap<HTMLAnchorElement, ReturnType<typeof setTimeout>>()
  document.addEventListener('pointerover', (e) => {
    const a = (e.target as HTMLElement | null)?.closest('a') as HTMLAnchorElement | null
    if (!a || timers.has(a)) return
    const url = prefetchUrlFor(a)
    if (!url) return
    timers.set(
      a,
      setTimeout(() => {
        timers.delete(a)
        void prefetchPage(url)
      }, HOVER_DELAY_MS),
    )
  })
  document.addEventListener('pointerout', (e) => {
    const a = (e.target as HTMLElement | null)?.closest('a') as HTMLAnchorElement | null
    if (!a) return
    // Moving between children of the same link is not a leave.
    if (e.relatedTarget instanceof Node && a.contains(e.relatedTarget)) return
    const t = timers.get(a)
    if (t !== undefined) {
      clearTimeout(t)
      timers.delete(a)
    }
  })
  document.addEventListener(
    'touchstart',
    (e) => {
      const a = (e.target as HTMLElement | null)?.closest('a') as HTMLAnchorElement | null
      if (!a) return
      const url = prefetchUrlFor(a)
      if (url) void prefetchPage(url)
    },
    { passive: true },
  )
}

function installInterceptor(): void {
  // We restore scroll ourselves on popstate (the page cache makes back/forward
  // an instant in-place swap); stop the browser's automatic restoration from
  // fighting the swap.
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual'
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null
    const a = target?.closest('a') as HTMLAnchorElement | null
    if (!a) return
    const intent = classifyClick(a, e)
    // 'external' → browser owns it; 'hash' → native in-page scroll. Both: leave alone.
    if (intent === 'external' || intent === 'hash') return
    // 'reload' or 'navigate' both suppress the browser's full page load.
    e.preventDefault()
    // 'reload' = clicking the page we're already on → no-op (no refetch).
    if (intent === 'reload') return
    void navigate(new URL(a.href, location.href), 'push')
  })
  window.addEventListener('popstate', () => {
    void navigate(new URL(location.href), 'none')
  })
}

/** Boot-path takeover for a DIRECT hit on a non-prerendered fallback path:
 * the static host served 404.html, which stashed the real URL in
 * sessionStorage and redirected to the route's fallback shell document. If
 * this document carries a fallback container, restore the real URL via
 * replaceState BEFORE takeover starts (the user sees their URL while the
 * placeholder loads, and takeover derives params from location.pathname),
 * then hand the container to the client-render runtime. */
function bootFallbackTakeover(): void {
  const el = document.querySelector<HTMLElement>('[data-brust-fallback-root]')
  if (!el) return
  let saved: string | null = null
  try {
    saved = sessionStorage.getItem('brust:fallback-path')
    if (saved !== null) sessionStorage.removeItem('brust:fallback-path')
  } catch {
    // sessionStorage unavailable (privacy mode) — 404.html couldn't have
    // stashed a path either; takeover proceeds on the shell's own URL.
  }
  // Only a same-origin absolute PATH is acceptable: the value transits
  // sessionStorage (writable by any same-origin script), so reject anything
  // shaped like a scheme or protocol-relative URL before handing it to
  // replaceState.
  if (saved?.startsWith('/') && !saved.startsWith('//')) {
    history.replaceState({}, '', saved)
    currentPageKey = location.pathname + location.search
    // Re-seed the nav store: __navInit ran before this with the SHELL
    // document's URL — without the re-init, useNav()/getNavState() would
    // report the /_brust/fallback/... path until the first SPA commit.
    __navInit(location.pathname, location.search)
  }
  // Per takeover's contract: unmount any island roots inside the container
  // first. At boot this is belt-and-braces — hydrateMarkersIn(document.body)
  // ran just above, but its `load`-trigger mounts are detached microtasks
  // that haven't created roots yet at this synchronous point.
  unmountIslandsIn(el)
  void takeover(el)
}

if (typeof document !== 'undefined') {
  registerNavigator((url, replace) => navigate(url, replace ? 'replace' : 'push'))
  currentPageKey = location.pathname + location.search
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      __navInit(location.pathname, location.search)
      installActiveNav()
      hydrateMarkersIn(document.body)
      installInterceptor()
      installPrefetch()
      bootFallbackTakeover()
    })
  } else {
    __navInit(location.pathname, location.search)
    installActiveNav()
    hydrateMarkersIn(document.body)
    installInterceptor()
    installPrefetch()
    bootFallbackTakeover()
  }
}
