import type { Instance } from './instance'
import { parseValue, resolve } from './value'
import { warnOnce } from './warn'
import { nearestInstance } from './instance'

function scopeOf(el: Element): Record<string, unknown> {
  let e: Element | null = el
  while (e) { const s = (e as unknown as { __scope?: Record<string, unknown> }).__scope; if (s) return s; e = e.parentElement }
  return {}
}

export function bindPropsFromParent(inst: Instance): void {
  const raw = inst.host.getAttribute('x-props-bind'); if (!raw) return
  const p = parseValue(raw)
  if (!p) { warnOnce(`pb:parse:${inst.name}`, `x-props-bind="${raw}" in ${inst.name}: not a member path`); return }
  const parent = inst.parent ?? nearestInstance(inst.host)
  if (!parent) { warnOnce(`pb:orphan:${inst.name}`, `x-props-bind="${raw}" in ${inst.name}: no parent, keeping seed`); return }
  const scope = scopeOf(inst.host)
  inst.effect(() => {
    const r = resolve(parent.members, p, scope)
    if (!r.ok) { warnOnce(`pb:missing:${inst.name}`, `x-props-bind="${raw}": no such member in ${parent.name}`); return }
    const v = r.value
    if (v && typeof v === 'object') inst.props.set(v as Record<string, unknown>)
  })
}
