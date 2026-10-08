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
  for (const child of Array.from(el.children)) {
    if ('__scope' in child) continue                          // x-for row: already bound with its own scope
    if (child.hasAttribute('x-for')) { bindElement(inst, child, scope); continue } // x-for owns the element (even when it is also a host)
    if (child.hasAttribute(HOST_ATTR)) continue               // nested host: its own instance binds it
    bindElement(inst, child, scope)
    if (!child.hasAttribute('x-if')) walkChildren(inst, child, scope)   // x-if owns its subtree
  }
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
