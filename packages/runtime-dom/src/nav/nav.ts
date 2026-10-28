// SPA navigation (design): a qualifying link click, `navigate()` or
// back/forward fetches the real HTML document and swaps it in place, so the page shows exactly what a full load of
// that URL shows (§2). Anything that cannot be swapped is a full load. Events: `brust:nav:click|load|success|error`.
import { applyHead, classicScripts, incomingImages, planHead, runScripts, swapBody } from './swap'

type Trigger = 'link' | 'navigate' | 'popstate'
export interface NavBridge { navigate(url: string, opts?: { replace?: boolean }): Promise<void>; clearCache(): void }
/** How a module script of the new page is loaded; tests swap it. */
export type Load = (url: string) => Promise<unknown>

const KEY = Symbol.for('brust.nav')
const LOADING = 'data-brust-loading'
const NAV = 'script[data-brust-nav]'
const noHash = (u: string) => u.split('#')[0]!
const sameDoc = (a: string, b: string) => noHash(a) === noHash(b)
/** A fetched document as the cache holds it (§10.1). `no`: never kept (`no-store`, a status of 400 or more). */
interface Got { status: number; url: string; type: string; text: string; no: boolean }
type VT = { skipTransition(): void; updateCallbackDone: Promise<void> }
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches
const BAR = 'data-brust-bar'

/** Boot once per tab. Returns a stop function (tests). */
export function boot(load: Load = (u) => import(/* @vite-ignore */ u)): () => void {
  const g = globalThis as { [KEY]?: NavBridge }
  const build = document.querySelector(NAV)?.getAttribute('data-brust-build')
  if (g[KEY] || build == null) return () => {}
  const off = new AbortController()
  const on = (t: EventTarget, type: string, h: (e: any) => void, capture?: boolean) =>
    t.addEventListener(type, h, { capture, passive: type === 'touchstart', signal: off.signal })
  const html = document.documentElement
  const fire = (name: string, detail: object, cancelable?: boolean) =>
    document.dispatchEvent(new CustomEvent('brust:nav:' + name, { detail, bubbles: true, cancelable }))

  // ---- history entries: an id per entry in history.state.brust, scroll positions in memory (§5.7) ----
  const stamp = Date.now().toString(36)
  let n = 0
  let seq = 0
  const pos = new Map<string, [number, number]>()
  const tag = (replaceUrl?: string) => {
    const id = stamp + n++
    history.replaceState({ ...history.state, brust: id }, '', replaceUrl)
    return id
  }
  let cur: string = history.state?.brust ?? tag()
  let shown = location.href
  history.scrollRestoration = 'manual'
  const land = (url: string, at?: [number, number]) => {
    if (at) return scrollTo(at[0], at[1])
    let t: Element | null = null
    try { const h = decodeURIComponent(new URL(url).hash.slice(1)); t = h ? document.getElementById(h) : null } catch {}
    t ? t.scrollIntoView() : scrollTo(0, 0)
  }

  // ---- the page cache (§10.1): an LRU of 32 documents by URL without its hash, filled by prefetches and navigations,
  // fresh for 5 minutes (`data-brust-cache` seconds), any age for back/forward; a fetch in flight (at: Infinity) is shared.
  // `seen` (F479): when each URL was last fetched, kept or not (32 of them, oldest out): a prefetch of one fetched less than
  // `data-brust-prefetch-gap` seconds ago (10; 0 = no gap) does nothing. It gates prefetches only; a navigation never waits.
  const cache = new Map<string, [Promise<Got>, number]>()
  const seen = new Map<string, number>()
  const gap = () => { const s = html.getAttribute('data-brust-prefetch-gap'); return s == null || isNaN(+s) ? 1e4 : +s * 1e3 }
  const ttl = () => { const s = html.getAttribute('data-brust-cache'); return s == null || isNaN(+s) ? 3e5 : +s * 1e3 }
  const get = (u: string, any?: boolean, init?: RequestInit): Promise<Got> => {
    const k = noHash(u)
    let e = cache.get(k)
    cache.delete(k)
    if (!e || !(any || Date.now() - e[1] < ttl())) {
      seen.delete(k)
      seen.set(k, Date.now())
      if (seen.size > 32) seen.delete(seen.keys().next().value!)
      const p = fetch(k, init).then(async (r) => ({ status: r.status, url: r.url, type: r.headers.get('content-type') ?? '', text: await r.text(), no: r.status >= 400 || /no-store/i.test(r.headers.get('cache-control') ?? '') }))
      const f = (e = [p, Infinity])
      const drop = () => cache.get(k) === f && cache.delete(k)
      p.then((g) => (g.no || !ttl() ? drop() : (f[1] = Date.now())), drop)
    }
    cache.set(k, e)
    if (cache.size > 32) cache.delete(cache.keys().next().value!)
    return e[0]
  }

  // ---- the progress bar (§10.2): only for a navigation still loading 150 ms after `load`; outside <body>, so no swap
  // removes it, and its <style> is runtime-added, so the head reconcile keeps it. The <style> goes first in the head
  // and its rules are one attribute selector each, so an app rule on div[data-brust-bar] wins ----
  let bar: Element | undefined
  let css: HTMLStyleElement | undefined
  let wait: ReturnType<typeof setTimeout> | undefined
  const progress = (on?: boolean) => {
    clearTimeout(wait)
    if (on) {
      if (!bar && html.getAttribute('data-brust-progress') !== 'off') wait = setTimeout(() => {
        if (!css) {
          ;(css = document.createElement('style')).textContent =
            `div[${BAR}]{position:fixed;z-index:2147483647;top:0;left:0;width:100%;height:var(--brust-progress-height,2px);pointer-events:none;background:var(--brust-progress-color,#2f7cf6);transform-origin:0;transform:scaleX(0);animation:brust-bar 8s cubic-bezier(.1,.8,.2,1) forwards}` +
            `div[${BAR}=done]{animation:none;transform:none;opacity:0;transition:transform .2s,opacity .3s .2s}@keyframes brust-bar{to{transform:scaleX(.8)}}` +
            `@media (prefers-reduced-motion:reduce){div[${BAR}]{animation:none;transform:scaleX(.8)}div[${BAR}=done]{transition:none}}`
          css.setAttribute(BAR, '')
        }
        if (!css.isConnected) document.head.prepend(css)
        html.append((bar = document.createElement('div')))
        bar.setAttribute(BAR, '')
      }, 150)
    } else if (bar) {
      const b = bar
      bar = undefined
      b.setAttribute(BAR, 'done')
      setTimeout(() => b.remove(), reduced() ? 0 : 500)
    }
  }

  // the head elements that came from the server (there at boot, or inserted from a fetched document): the only ones the
  // head reconcile may remove (§3 step 5)
  const served = new WeakSet<Element>(document.head.children)

  /** The URL a link navigates to, or null when the click (or a prefetch) is left to the browser (§5.1). */
  const target = (t: EventTarget | null): [Element, string] | null => {
    const a = (t as Element | null)?.closest?.('a')
    const href = a?.getAttribute('href')
    if (href == null || a!.hasAttribute('download') || (a!.getAttribute('target') || '_self').toLowerCase() !== '_self' || a!.closest('[data-brust-reload]')) return null
    let u: URL
    try { u = new URL(href, document.baseURI) } catch { return null }
    if (u.origin !== location.origin || !/^https?:$/.test(u.protocol) || (u.href.includes('#') && sameDoc(u.href, location.href))) return null
    return [a!, u.href]
  }

  const prefetch = (t: EventTarget | null) => {
    const l = target(t)
    const c = (navigator as { connection?: { saveData?: boolean; effectiveType?: string } }).connection
    if (!l || l[0].closest('[data-brust-prefetch="false"]') || c?.saveData || /2g/.test(c?.effectiveType ?? '') || sameDoc(l[1], location.href)) return
    const at = seen.get(noHash(l[1]))
    if (at != null && Date.now() - at < gap()) return
    get(l[1], false, { priority: 'low' } as RequestInit).catch(() => {})
  }

  // ---- one navigation (§3); a newer one supersedes it (and skips its transition) and it fires nothing more ----
  let active = 0
  let vt: VT | undefined
  const go = async (req: string, trigger: Trigger, id: number, replace: boolean, pop?: string): Promise<void> => {
    vt?.skipTransition()
    const me = ++active
    const live = () => me === active
    const from = shown
    let url = req
    let status = 0
    let pushed = false
    const added: Element[] = []
    html.setAttribute(LOADING, '')
    progress(true)
    fire('load', { id, url, from, trigger })
    try {
      // not aborted when superseded: the response still fills the cache
      const res = await get(req, trigger === 'popstate')
      if (!live()) return
      status = res.status
      // the final URL (after redirects); a fetch drops the fragment, which a redirect without one keeps
      const fin = new URL(res.url || req)
      // a redirect that left this origin (an open redirect to a CORS-readable page) is never parsed: a full load
      if (fin.origin !== location.origin) throw new Error('cross-origin')
      fin.hash ||= new URL(req).hash
      url = fin.href
      const doc = /html/.test(res.type) ? new DOMParser().parseFromString(res.text, 'text/html') : null
      if (doc?.querySelector(NAV)?.getAttribute('data-brust-build') !== build) throw new Error(`not a brust page of this build`)

      // §3 step 4: everything the new page needs before it is shown. The store tags first, at the end of the body, after
      // the old ones (a store seeds from the first tag of its name; a live store never re-reads one): an old-page island
      // that hydrates while the modules load still finds its own page's tag, and a store new to this page, first read
      // by one of its modules, finds the new one. The swap removes them with the old body tail. Then the module scripts
      // in document order (one at a time: the order they register in is the order the server wrote), then the
      // stylesheets the head plan inserted, with `media="not all"`: loaded and parsed, applied to nothing until the swap.
      const stores = Array.from(doc.querySelectorAll('script[data-brust-store]'), (s) => document.importNode(s, true))
      document.body.append(...stores)
      added.push(...stores)
      for (const s of doc.querySelectorAll('script[type=module][src]')) {
        if (!s.matches(NAV)) await load(new URL(s.getAttribute('src')!, url).href)
        if (!live()) return
      }
      const plan = planHead([...doc.head.children])
      added.push(...plan.sheets.map(([e]) => e))
      // a load event is a later task: the handlers set now still catch a cached sheet
      await Promise.all(plan.sheets.map(([e]) => new Promise((r) => { (e as HTMLLinkElement).onload = (e as HTMLLinkElement).onerror = r })))
      if (!live()) return

      // §3 step 5: swap (one task, nothing painted in between), then history and scroll
      let fresh: Element[] = []
      let body: HTMLScriptElement[] = []
      let whole = false
      const swap = () => {
        if (!live()) return
        for (const [e, m] of plan.sheets) m == null ? e.removeAttribute('media') : e.setAttribute('media', m)
        pos.set(cur, [scrollX, scrollY])
        for (const e of added) served.add(e)
        fresh = applyHead(plan, (e) => served.has(e))
        for (const e of fresh) served.add(e)
        ;[body, whole] = swapBody(doc, LOADING)
        added.length = 0
        if (trigger === 'popstate') cur = pop || tag()
        else if (replace) history.replaceState({ ...history.state, brust: cur }, '', url)
        else history.pushState({ brust: (cur = stamp + n++) }, '', url)
        pushed = true
        shown = location.href
        land(url, pos.get(pop!))
      }
      // §10.3: the swap inside a view transition (a root cross-fade). Everything slow is done by now. The first 8 images the
      // swap puts in (the changed level's, so a kept layout's never take a slot) that are not lazy and not on screen
      // already are preloaded (the same candidate: srcset, sizes,
      // crossorigin and referrerpolicy copied) and get 100 ms in all to decode, so none pops in after the fade. `swap`
      // runs once: a throw from it rejects updateCallbackDone and takes the error path; a throw from startViewTransition
      // itself is a direct swap.
      const start = (document as { startViewTransition?: (u: () => void) => VT }).startViewTransition
      let t: VT | undefined
      if (start && html.getAttribute('data-brust-transition') !== 'off' && !reduced()) {
        const abs = (u: string | null) => (u ? new URL(u, url).href : '')
        const onScreen = new Set([...document.querySelectorAll('img')].flatMap((i) => [i.src, i.currentSrc]).filter(Boolean))
        await Promise.race([
          new Promise((r) => setTimeout(r, 100)),
          Promise.all(incomingImages(doc)
            .filter((i) => i.getAttribute('loading') !== 'lazy' && (i.hasAttribute('src') || i.hasAttribute('srcset')) && !onScreen.has(abs(i.getAttribute('src'))))
            .slice(0, 8)
            .map((i) => {
              const m = new Image()
              for (const a of ['crossorigin', 'referrerpolicy', 'sizes']) if (i.hasAttribute(a)) m.setAttribute(a, i.getAttribute(a)!)
              const set = i.getAttribute('srcset')
              if (set) m.srcset = set.replace(/(^|,)(\s*)([^\s,]+)/g, (_, c, w, u) => c + w + abs(u))
              if (i.hasAttribute('src')) m.src = abs(i.getAttribute('src'))
              return m.decode().catch(() => {})
            })),
        ])
        if (!live()) return
        try { vt = t = start.call(document, swap) } catch {}
      }
      t ? await t.updateCallbackDone : swap()
      if (!live()) return
      // the head scripts new to it run; after a whole-body swap (<html> and <body> attributes replaced) every one the
      // server sent runs again, as on a full load (a theme script setting <html class>), but a data-brust-once one only
      // if it is new, and one a component added at runtime never (a loader such as Stripe.js must not run twice). A
      // re-created script is the server's too, so the next reconcile still removes it.
      const head = whole ? [...document.head.children].filter((e) => served.has(e) && (!e.hasAttribute('data-brust-once') || fresh.includes(e))) : fresh
      await runScripts([...classicScripts(head), ...body], (s) => served.add(s))
      if (!live()) return
      html.removeAttribute(LOADING)
      progress()
      if (status < 400) fire('success', { id, url, from, trigger, status })
      else fire('error', { id, url, from, trigger, status, error: undefined, swapped: true })
    } catch (error) {
      if (!live()) return
      html.removeAttribute(LOADING)
      progress()
      cache.delete(noHash(req))
      // nothing could be swapped: the default action is a full load of the URL (cancelable)
      if (fire('error', { id, url, from, trigger, status, error, swapped: false }, true)) location[pushed || trigger === 'popstate' ? 'replace' : 'assign'](url)
    } finally {
      for (const e of added) e.remove()
    }
  }

  const navigate = (u: string, o?: { replace?: boolean }): Promise<void> => {
    const url = new URL(u, location.href).href
    if (url.startsWith(location.origin + '/') && !document.body.closest('[data-brust-reload]') && !(url.includes('#') && sameDoc(url, location.href)))
      return go(url, 'navigate', ++seq, !!o?.replace || sameDoc(url, location.href))
    location[o?.replace ? 'replace' : 'assign'](url)
    return Promise.resolve()
  }
  g[KEY] = { navigate, clearCache: () => (cache.clear(), seen.clear()) }

  on(document, 'click', (e: MouseEvent) => {
    if (e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    const l = target(e.target)
    if (!l) return
    // the click navigates now: a hover intent still pending would refetch a page the cache does not keep
    clearTimeout(hover)
    const id = ++seq
    if (!fire('click', { id, url: l[1], from: shown, link: l[0] }, true)) return
    e.preventDefault()
    void go(l[1], 'link', id, sameDoc(l[1], location.href))
  })
  let hover: ReturnType<typeof setTimeout> | undefined
  const isA = (t: EventTarget | null) => (t as Element | null)?.localName === 'a'
  on(document, 'pointerenter', (e) => { if (isA(e.target)) hover = setTimeout(() => prefetch(e.target), 65) }, true)
  on(document, 'pointerleave', (e) => { if (isA(e.target)) clearTimeout(hover) }, true)
  on(document, 'focusin', (e) => prefetch(e.target))
  on(document, 'touchstart', (e) => prefetch(e.target), true)
  on(window, 'popstate', (e: PopStateEvent) => {
    const to: string | undefined = e.state?.brust
    if (sameDoc(location.href, shown)) {
      // a fragment entry of the page on screen: the browser owns it; keep the scroll of the entry left
      pos.set(cur, [scrollX, scrollY])
      cur = to || tag()
      shown = location.href
      return land(shown, pos.get(cur))
    }
    void go(location.href, 'popstate', ++seq, false, to)
  })
  return () => {
    off.abort()
    delete g[KEY]
  }
}
