// The DOM half of a navigation (design §3 step 5): the head made equal to the new head, then the body swapped whole or
// from one layout level down (§5.9), persisted elements moved over, and the new classic scripts run.
import { between, readChain, swapLevel } from './chain'

/** `sheets`: the inserted stylesheets with their own `media` (null: none); they carry `media="not all"` until the swap. */
const SHEET = 'link[rel~=stylesheet]'

export interface HeadPlan { want: Element[]; fixed: Set<Element>; sheets: [Element, string | null][] }

/**
 * §3 step 5, planned before the swap: each new head element is matched to an unused old one with the same outerHTML
 * (kept, never re-created) or is new. The kept elements already in the right order (the longest such run) never move.
 * A new stylesheet, or a kept one out of that run, is inserted now at its final place (a clone for a kept one): a moved
 * `<link>` drops its sheet until a later task, a visible flash, so no loaded stylesheet ever moves. They go in with
 * `media="not all"` (loaded and parsed, applied to nothing) and come back in `sheets` for the caller to await.
 */
export function planHead(next: Element[]): HeadPlan {
  const head = document.head
  const old = Array.from(head.children)
  const pool = new Map<string, Element[]>()
  for (const el of old) { const k = el.outerHTML; pool.has(k) ? pool.get(k)!.push(el) : pool.set(k, [el]) }
  const want = next.map((n) => pool.get(n.outerHTML)?.shift() ?? n)
  // the heaviest run of old elements already in order, a stylesheet outweighing everything else (a head is small:
  // quadratic is fine)
  const at = want.map((el) => old.indexOf(el))
  const w: number[] = []
  const prev: number[] = []
  let best = -1
  at.forEach((v, i) => {
    if (v < 0) return
    const own = want[i]!.matches(SHEET) ? 1e3 : 1
    w[i] = own
    prev[i] = -1
    for (let j = 0; j < i; j++) if (at[j]! >= 0 && at[j]! < v && w[j]! + own > w[i]!) { w[i] = w[j]! + own; prev[i] = j }
    if (best < 0 || w[i]! > w[best]!) best = i
  })
  const fixed = new Set<Element>()
  for (let i = best; i >= 0; i = prev[i]!) fixed.add(want[i]!)
  const sheets: HeadPlan['sheets'] = []
  want.forEach((el, i) => {
    if (fixed.has(el) || !el.matches(SHEET)) return
    const s = el.ownerDocument === document ? (el.cloneNode() as Element) : document.adoptNode(el)
    sheets.push([s, s.getAttribute('media')])
    s.setAttribute('media', 'not all')
    head.insertBefore(s, want.slice(i + 1).find((e) => fixed.has(e)) ?? null)
    fixed.add((want[i] = s))
  })
  return { want, fixed, sheets }
}

/** Make the head's element children exactly `plan.want`, moving no fixed element. Returns the elements new to it. */
export function applyHead({ want, fixed }: HeadPlan): Element[] {
  const head = document.head
  const keep = new Set(want)
  for (const el of Array.from(head.children)) if (!keep.has(el)) el.remove()
  const fresh: Element[] = []
  let prev: Element | null = null
  for (let el of want) {
    if (el.ownerDocument !== document) fresh.push((el = document.adoptNode(el)))
    // the fixed elements are already in order: every other one goes right after the one before it
    if (!fixed.has(el) && (prev ? prev.nextElementSibling : head.firstElementChild) !== el) prev ? prev.after(el) : head.prepend(el)
    prev = el
  }
  return fresh
}

function copyAttrs(to: Element, from: Element, keep?: string): void {
  for (const a of Array.from(to.attributes)) if (a.name !== keep && !from.hasAttribute(a.name)) to.removeAttribute(a.name)
  for (const a of Array.from(from.attributes)) to.setAttribute(a.name, a.value)
}

const all = (nodes: Node[], sel: string) =>
  nodes.flatMap((n) => (n instanceof Element ? [...(n.matches(sel) ? [n] : []), ...Array.from(n.querySelectorAll(sel))] : []))

const P = '[data-brust-persist]'
const key = (el: Element) => el.getAttribute('data-brust-persist')!

/**
 * A live `data-brust-persist` element replaces the inserted element with the same key, in the same task as the swap:
 * it never leaves this document (no adoption into the parsed one), so it is moved, never disposed.
 */
function persist(old: Node[]): (next: Node[]) => void {
  const live = new Map(all(old, P).map((el) => [key(el), el]))
  return (next) => { for (const el of all(next, P)) { const k = live.get(key(el)); if (k) el.replaceWith(k) } }
}

/** The body-end assets: the nav tag and every node after it (store tags, module scripts). */
function tail(body: HTMLElement): ChildNode[] | null {
  const tag = body.querySelector(':scope > script[data-brust-nav]')
  const out: ChildNode[] = []
  for (let n: ChildNode | null = tag; n; n = n.nextSibling) out.push(n)
  return tag && out
}

/**
 * Swap the body to `doc`'s (§5.9): from the first level that changed, or the whole body (with the attributes of
 * `<html>` and `<body>`) when the root changed or a chain cannot be trusted. Returns the inserted nodes.
 */
export function swapBody(doc: Document, loading: string): Node[] {
  const body = document.body
  const a = readChain(document)
  const b = readChain(doc)
  const i = swapLevel(a, b)
  const ta = tail(body)
  const tb = tail(doc.body)
  if (i && ta && tb) {
    const old = between(a![i]!)
    const next = between(b![i]!)
    const keep = persist(old)
    for (const n of old.slice(1)) n.remove()
    old[0]!.replaceWith(...next)
    keep(next)
    for (const n of ta) n.remove()
    body.append(...tb)
    return [...next, ...tb]
  }
  copyAttrs(document.documentElement, doc.documentElement, loading)
  copyAttrs(body, doc.body)
  const next = Array.from(doc.body.childNodes)
  const keep = persist(Array.from(body.childNodes))
  body.replaceChildren(...next)
  keep(next)
  return next
}

const isClassic = (s: Element) => !(s as HTMLScriptElement).type || /java|ecma/i.test((s as HTMLScriptElement).type)

/** The classic scripts among `nodes` (and under them), in document order. */
export const classicScripts = (nodes: Node[]) => all(nodes, 'script').filter(isClassic) as HTMLScriptElement[]

/** Run each script as a full load would: re-created (a parsed one never runs), one after the other, a `src` awaited. */
export async function runScripts(list: HTMLScriptElement[]): Promise<void> {
  for (const old of list) {
    if (!old.isConnected) continue
    const s = document.createElement('script')
    for (const a of Array.from(old.attributes)) s.setAttribute(a.name, a.value)
    s.text = old.text
    const done = s.src && new Promise((r) => { s.onload = s.onerror = r })
    old.replaceWith(s)
    await done
  }
}
