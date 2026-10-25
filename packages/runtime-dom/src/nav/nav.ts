// SPA navigation (design docs/design/2026-10-25-spa-navigation-design.md): a qualifying link click, `navigate()` or
// back/forward fetches the real HTML document and swaps it in place, so the page shows exactly what a full load of
// that URL shows (§2). Anything that cannot be swapped is a full load. Events: `brust:nav:click|load|success|error`.
import { applyHead, classicScripts, planHead, runScripts, swapBody } from './swap'

type Trigger = 'link' | 'navigate' | 'popstate'
export interface NavBridge { navigate(url: string, opts?: { replace?: boolean }): Promise<void> }
/** How a module script of the new page is loaded; tests swap it. */
export type Load = (url: string) => Promise<unknown>

const KEY = Symbol.for('brust.nav')
const LOADING = 'data-brust-loading'
const NAV = 'script[data-brust-nav]'
const sameDoc = (a: string, b: string) => a.split('#')[0] === b.split('#')[0]

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

  // ---- prefetch on intent (§5.2): one response per URL, held 15 s, used once ----
  const held = new Map<string, [Promise<Response>, number]>()
  const take = (u: string) => {
    const e = held.get(u)
    held.delete(u)
    return e && e[1] > Date.now() ? e[0] : undefined
  }

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
    if (!l || l[0].closest('[data-brust-prefetch="false"]') || c?.saveData || /2g/.test(c?.effectiveType ?? '')) return
    const u = l[1]
    if ((held.get(u)?.[1] ?? 0) > Date.now()) return
    const p = fetch(u, { priority: 'low' } as RequestInit)
    p.catch(() => {})
    held.set(u, [p, Date.now() + 15e3])
  }

  // ---- one navigation (§3); a newer one aborts it and it fires nothing more ----
  let active: AbortController | null = null
  const go = async (req: string, trigger: Trigger, id: number, replace: boolean, pop?: string): Promise<void> => {
    active?.abort()
    const c = (active = new AbortController())
    const live = () => c === active
    const from = shown
    let url = req
    let status = 0
    let pushed = false
    const added: Element[] = []
    html.setAttribute(LOADING, '')
    fire('load', { id, url, from, trigger })
    try {
      const res = await (take(req) ?? fetch(req, { signal: c.signal }))
      if (!live()) return
      status = res.status
      // the final URL (after redirects); a fetch drops the fragment, which a redirect without one keeps
      const fin = new URL(res.url || req)
      fin.hash ||= new URL(req).hash
      url = fin.href
      const doc = /html/.test(res.headers.get('content-type') ?? '') ? new DOMParser().parseFromString(await res.text(), 'text/html') : null
      if (!live()) return
      if (doc?.querySelector(NAV)?.getAttribute('data-brust-build') !== build) throw new Error(`not a brust document of this build: ${url}`)

      // §3 step 4: everything the new page needs before it is shown. The store tags first, ahead of the old ones (a
      // store seeds from the first tag of its name; a live store never re-reads one), then the module scripts in
      // document order (one at a time: the order they register in is the order the server wrote), then the stylesheets
      // the head plan inserted, with `media="not all"`: loaded and parsed, applied to nothing until the swap.
      const stores = Array.from(doc.querySelectorAll('script[data-brust-store]'), (s) => document.importNode(s, true))
      document.head.append(...stores)
      added.push(...stores)
      for (const s of Array.from(doc.querySelectorAll('script[type=module][src]'))) {
        if (!s.matches(NAV)) await load(new URL(s.getAttribute('src')!, url).href)
        if (!live()) return
      }
      const plan = planHead(Array.from(doc.head.children))
      added.push(...plan.sheets.map(([e]) => e))
      // a load event is a later task: the handlers set now still catch a cached sheet
      await Promise.all(plan.sheets.map(([e]) => new Promise((r) => { (e as HTMLLinkElement).onload = (e as HTMLLinkElement).onerror = r })))
      if (!live()) return

      // §3 step 5: swap (one task, nothing painted in between), then history and scroll
      for (const [e, m] of plan.sheets) m == null ? e.removeAttribute('media') : e.setAttribute('media', m)
      pos.set(cur, [scrollX, scrollY])
      const fresh = applyHead(plan)
      const body = swapBody(doc, LOADING)
      added.length = 0
      if (trigger === 'popstate') cur = pop || tag()
      else if (replace) history.replaceState({ ...history.state, brust: cur }, '', url)
      else history.pushState({ brust: (cur = stamp + n++) }, '', url)
      pushed = true
      shown = location.href
      land(url, pos.get(pop!))
      await runScripts(classicScripts([...fresh, ...body]))
      if (!live()) return
      html.removeAttribute(LOADING)
      if (status < 400) fire('success', { id, url, from, trigger, status })
      else fire('error', { id, url, from, trigger, status, error: undefined, swapped: true })
    } catch (error) {
      if (!live()) return
      html.removeAttribute(LOADING)
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
  g[KEY] = { navigate }

  on(document, 'click', (e: MouseEvent) => {
    if (e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    const l = target(e.target)
    if (!l) return
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
