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

let inFlight: AbortController | null = null

export async function navigate(url: URL, mode: 'push' | 'replace' | 'none'): Promise<void> {
  inFlight?.abort()
  const ac = new AbortController()
  inFlight = ac
  try {
    __navStart(url.pathname, url.search)
    const resp = await fetch(`/_brust/page${url.pathname}${url.search}`, {
      signal: ac.signal,
      headers: { Accept: 'application/json' },
    })
    if (!resp.ok) throw new Error(`navigation: status ${resp.status}`)
    const { html, title, store } = (await resp.json()) as {
      html: string
      title: string
      store?: Record<string, Record<string, unknown>>
    }
    const main = document.querySelector('main')
    if (!main) throw new Error('navigation: no <main> element')
    unmountIslandsIn(main as HTMLElement)
    swapMainContent(main as HTMLElement, html)
    if (store) applyStoreSnapshot(store)
    if (title) document.title = title
    if (mode === 'push') history.pushState({}, '', url.href)
    else if (mode === 'replace') history.replaceState({}, '', url.href)
    window.scrollTo(0, 0)
    hydrateMarkersIn(main as HTMLElement)
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

function installInterceptor(): void {
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

if (typeof document !== 'undefined') {
  registerNavigator((url, replace) => navigate(url, replace ? 'replace' : 'push'))
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      __navInit(location.pathname, location.search)
      installActiveNav()
      hydrateMarkersIn(document.body)
      installInterceptor()
    })
  } else {
    __navInit(location.pathname, location.search)
    installActiveNav()
    hydrateMarkersIn(document.body)
    installInterceptor()
  }
}
