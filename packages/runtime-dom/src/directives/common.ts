import { parseValue, resolve, resolveMember, type ParsedValue, type Scope } from '../value'
import { warnOnce } from '../warn'
import type { Instance } from '../instance'

export function parsed(inst: Instance, attr: string, raw: string): ParsedValue | null {
  const p = parseValue(raw)
  if (!p) warnOnce(`parse:${inst.name}:${attr}:${raw}`, `${attr}="${raw}" on x-data="${inst.name}" is not a member path (expressions are not allowed)`)
  return p
}
export function read(inst: Instance, p: ParsedValue, scope: Scope, attr: string): { ok: boolean; value: unknown } {
  const r = resolve(inst.members, p, scope)
  if (!r.ok) warnOnce(`missing:${inst.name}:${attr}:${p.path.join('.')}`, `${attr}="${p.path.join('.')}" on x-data="${inst.name}": no such member`)
  return r.ok ? r : { ok: false, value: undefined }
}
export function member(inst: Instance, p: ParsedValue, attr: string): unknown {
  const m = resolveMember(inst.members, p)
  if (m === undefined) warnOnce(`missing:${inst.name}:${attr}:${p.path.join('.')}`, `${attr}="${p.path.join('.')}" on x-data="${inst.name}": no such member`)
  return m
}
export function mismatch(inst: Instance, attr: string, el: Element, server: unknown, client: unknown): void {
  if (inst.booted) return   // element created after mount (new x-for row / x-if clone): nothing was server-rendered
  warnOnce(`mismatch:${inst.name}:${attr}`, `first-paint mismatch on <${el.tagName.toLowerCase()} ${attr}> in x-data="${inst.name}": server=${JSON.stringify(server)} client=${JSON.stringify(client)} (compiler bug: §6.3)`)
}
