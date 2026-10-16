import type { Instance } from './instance'
import { parseValue, resolve } from './value'
import { warnOnce } from './warn'
import { nearestInstance } from './instance'

function scopeOf(el: Element): Record<string, unknown> {
  let e: Element | null = el
  while (e) { const s = (e as unknown as { __scope?: Record<string, unknown> }).__scope; if (s) return s; e = e.parentElement }
  return {}
}

/** F277: the props a linked host starts with: its parent's current `x-props-bind` value when the parent is mounted (a
 * host an `x-if` or a row creates after first paint gets what the parent passes NOW, as React mounts with the current
 * props: a `useState(prop)` starts from it), else its printed `x-props`. */
export function initialProps(host: HTMLElement, parent: Instance | null, printed: Record<string, unknown>): Record<string, unknown> {
  const raw = host.getAttribute('x-props-bind'); if (!raw || !parent) return printed
  const p = parseValue(raw); if (!p) return printed
  const r = resolve(parent.members, p, scopeOf(host))
  return r.ok && r.value && typeof r.value === 'object' ? (r.value as Record<string, unknown>) : printed
}

export function bindPropsFromParent(inst: Instance): void {
  const raw = inst.host.getAttribute('x-props-bind'); if (!raw) return
  const p = parseValue(raw)
  if (!p) { warnOnce(`pp:${inst.name}`, `x-props-bind="${raw}" in ${inst.name}: not a member path`); return }
  const parent = inst.parent ?? nearestInstance(inst.host)
  if (!parent) {
    // An unmounted ancestor host means "wait" (the parent's mount links us); only a truly parentless host is an error.
    if (!inst.host.parentElement?.closest('[x-data]')) warnOnce(`po:${inst.name}`, `x-props-bind="${raw}" in ${inst.name}: no parent`)
    return
  }
  const scope = scopeOf(inst.host)
  inst.effect(() => {
    const r = resolve(parent.members, p, scope)
    if (!r.ok) { warnOnce(`pm:${inst.name}`, `x-props-bind="${raw}": no such member in ${parent.name}`); return }
    const v = r.value
    if (v && typeof v === 'object') inst.props.set(v as Record<string, unknown>)
    else warnOnce(`pn:${inst.name}`, `x-props-bind="${raw}" in ${inst.name}: not an object`)
  })
}
