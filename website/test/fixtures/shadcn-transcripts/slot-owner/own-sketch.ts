// F307 option A sketch (NOT shipped, not wired, size measurement only): slot content a caller prints inside a child's
// host carries `x-own="<k>:<owner name>"` on each top-level element: it is bound by the k-th enclosing host (k >= 1),
// which must be an instance of <owner name>, in the scope that host's walk had at the call site; everything else skips it.
import { bindElement, walkChildren } from '../../../packages/runtime-dom/src/directives/index'
import { instances, type Instance } from '../../../packages/runtime-dom/src/instance'
import type { Scope } from '../../../packages/runtime-dom/src/value'
import { warnOnce } from '../../../packages/runtime-dom/src/warn'

const OWN = 'x-own'
const bound = new WeakSet<Element>()
const ancestorHost = (el: Element): Element | null => el.parentElement?.closest('[x-data]') ?? null

/** The owner host of an `x-own` element and the host just below it (whose position is the call site), or null. */
function owner(el: Element): [Element, Element] | null {
  const m = /^(\d{1,2}):([\w$-]+)$/.exec(el.getAttribute(OWN) ?? '')
  if (!m) return null
  let below: Element | null = null
  let h: Element | null = el
  for (let i = 0; i < Number(m[1]); i++) { below = h === el ? null : h; h = h && ancestorHost(h) }
  if (!h || h.getAttribute('x-data') !== m[2]) return null
  return [h, below ?? (ancestorHost(el) as Element)]
}

function scopeAt(el: Element): Scope {
  for (let e: Element | null = el; e; e = e.parentElement) { const s = (e as { __scope?: Scope }).__scope; if (s) return s }
  return {}
}

/** `walkChildren` also skips `[x-own]` (one more `continue` there); this binds the ones `inst` owns under `root`. */
export function bindOwned(inst: Instance, root: ParentNode): void {
  root.querySelectorAll(`[${OWN}]`).forEach((el) => {
    if (bound.has(el)) return
    const o = owner(el)
    if (!o) { warnOnce(`own:${el.getAttribute(OWN)}`, `${OWN}="${el.getAttribute(OWN)}": no such owner`); return }
    if (o[0] !== inst.host) return
    bound.add(el)
    const scope = scopeAt(o[1])
    bindElement(inst, el, scope)
    if (!el.hasAttribute('x-if')) walkChildren(inst, el, scope)
  })
}

/** For a subtree a binder or the observer adds: each owner that is already mounted binds what it owns there. */
export function bindAdded(root: ParentNode): void {
  root.querySelectorAll(`[${OWN}]`).forEach((el) => {
    const o = owner(el)
    const inst = o && instances.get(o[0])
    if (inst) bindOwned(inst, el.parentElement ?? root)
  })
}
