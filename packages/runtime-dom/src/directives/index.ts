import type { Instance } from '../instance'
import type { Scope } from '../value'

export type Binder = (ctx: { inst: Instance; el: Element; attr: string; raw: string; scope: Scope }) => void
/** attribute-name prefix → binder. Exact names first, then prefixes (x-bind-, x-on-). */
export const BINDERS: Array<{ match: (attr: string) => boolean; bind: Binder }> = []

const HOST_ATTR = 'x-data'
/** Install binders for every x-* attribute under `el` (inclusive), not descending into nested hosts. */
export function bindHost(inst: Instance, el: Element, scope: Scope): void {
  bindElement(inst, el, scope)
  walkChildren(inst, el, scope)
}
export function walkChildren(inst: Instance, el: Element, scope: Scope): void {
  if (el.hasAttribute('x-html') || el.hasAttribute('x-raw') || el.localName === 'brust-island') return   // raw markup / React island: inert
  for (const child of Array.from(el.children)) {
    if ('__scope' in child) continue                          // x-for row: already bound with its own scope
    if (child.hasAttribute('x-for')) { bindElement(inst, child, scope); continue } // x-for owns the element (even when it is also a host)
    if (child.hasAttribute(HOST_ATTR)) {                       // nested host: its own instance binds it,
      const pref = child.getAttribute('x-pref')                // but the ref its caller passed is the caller's (F267/F288)
      if (pref) bindRef(inst, child, pref)
      continue
    }
    bindElement(inst, child, scope)
    if (!child.hasAttribute('x-if')) walkChildren(inst, child, scope)   // x-if owns its subtree
  }
}
/** `x-ref` / `x-pref`: the instance's ref cell `name` holds `el` while it is bound. */
export function bindRef(inst: Instance, el: Element, name: string): void {
  const r = inst.ref(name.trim())
  r.current = el as HTMLElement
  inst.onCleanup(() => { if (r.current === el) r.current = null })
}
export function bindElement(inst: Instance, el: Element, scope: Scope): void {
  // Structural directives own the element: x-for/x-if re-create it from a template, so the
  // remaining attributes are bound on the clones (with the right scope), never on this original.
  const structural = el.hasAttribute('x-for') ? 'x-for' : el.hasAttribute('x-if') ? 'x-if' : null
  for (const attr of Array.from(el.attributes)) {
    if (structural && attr.name !== structural) continue
    if (!attr.name.startsWith('x-') || attr.name === HOST_ATTR || attr.name === 'x-props' || attr.name === 'x-props-bind') continue
    const b = BINDERS.find((b) => b.match(attr.name))
    if (b) b.bind({ inst, el, attr: attr.name, raw: attr.value, scope })
  }
}
