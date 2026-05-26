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

import { hydrateRoot, type Root } from 'react-dom/client'
import { createElement } from 'react'

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
      const rIC = (globalThis as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback
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

async function hydrateOne(el: HTMLElement): Promise<void> {
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
    const mod = await import(`/_brust/islands/${id}.js`)
    const Component = (mod.default ?? mod) as React.ComponentType<Record<string, unknown>>
    if (typeof Component !== 'function') {
      console.error(`[brust] island "${id}": chunk has no default-exported component`)
      return
    }
    const root = hydrateRoot(el, createElement(Component, props))
    islandRoots.set(el, root)
  } catch (e) {
    console.error(`[brust] island "${id}": hydration failed`, e)
  }
}

/** Unmount any React roots that live inside `root`. Must run BEFORE
 * removing or replacing their DOM, otherwise React's scheduler keeps
 * posting work to detached nodes and the tab hangs. */
function unmountIslandsIn(root: ParentNode): void {
  const markers = root.querySelectorAll<HTMLElement>('[data-brust-island]')
  for (const el of Array.from(markers)) {
    const r = islandRoots.get(el)
    if (r) {
      try { r.unmount() } catch (e) { console.warn('[brust] island unmount failed', e) }
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
  const markers = root.querySelectorAll<HTMLElement>('[data-brust-island]:not([data-brust-hydrated])')
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

/** Classifier — true iff the event should be intercepted as a SPA
 * navigation. Exported for unit testing. */
export function isInternalLink(a: HTMLAnchorElement, event: MouseEvent): boolean {
  if (event.defaultPrevented) return false
  if (event.button !== 0) return false
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false
  if (a.target && a.target !== '_self') return false
  if (a.hasAttribute('download')) return false
  if (a.dataset.brustNoIntercept !== undefined) return false
  const url = new URL(a.href, location.href)
  if (url.origin !== location.origin) return false
  // Same-pathname links: hash-only changes use the browser's native scroll;
  // hash-absent same-URL clicks (e.g., logo back to current page) are
  // redundant — let the browser handle them as no-ops (no SPA refetch).
  if (url.pathname === location.pathname && url.search === location.search) return false
  if (url.pathname.startsWith('/_brust/')) return false
  return true
}

let inFlight: AbortController | null = null

async function navigate(url: URL, push: boolean): Promise<void> {
  inFlight?.abort()
  const ac = new AbortController()
  inFlight = ac
  try {
    const resp = await fetch(`/_brust/page${url.pathname}${url.search}`, {
      signal: ac.signal,
      headers: { 'Accept': 'application/json' },
    })
    if (!resp.ok) throw new Error(`navigation: status ${resp.status}`)
    const { html, title } = await resp.json() as { html: string; title: string }
    const main = document.querySelector('main')
    if (!main) throw new Error('navigation: no <main> element')
    unmountIslandsIn(main as HTMLElement)
    swapMainContent(main as HTMLElement, html)
    if (title) document.title = title
    if (push) history.pushState({}, '', url.href)
    window.scrollTo(0, 0)
    hydrateMarkersIn(main as HTMLElement)
  } catch (err) {
    if ((err as Error).name === 'AbortError') return
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
    if (!a || !isInternalLink(a, e)) return
    e.preventDefault()
    void navigate(new URL(a.href, location.href), /* push */ true)
  })
  window.addEventListener('popstate', () => {
    void navigate(new URL(location.href), /* push */ false)
  })
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      hydrateMarkersIn(document.body)
      installInterceptor()
    })
  } else {
    hydrateMarkersIn(document.body)
    installInterceptor()
  }
}
