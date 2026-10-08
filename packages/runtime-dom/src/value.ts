import { isSignal } from './signal'
export interface ParsedValue { path: string[]; bindings: string[] }
const IDENT = /^[A-Za-z_$][\w$]*$/

export function parseValue(raw: string): ParsedValue | null {
  const [pathPart, bindPart, ...rest] = raw.trim().split(':')
  if (rest.length || !pathPart) return null
  const path = pathPart.split('.')
  if (!path.every((p) => IDENT.test(p))) return null
  const bindings = bindPart === undefined ? [] : bindPart.split(',').map((b) => b.trim())
  if (!bindings.every((b) => IDENT.test(b))) return null
  return { path, bindings }
}

export type Scope = Record<string, unknown>

/** Resolve a parsed directive value against instance members. Reads signals (tracked). */
export function resolve(members: Record<string, unknown>, v: ParsedValue, scope: Scope): { ok: true; value: unknown } | { ok: false } {
  let cur: unknown = members
  for (const key of v.path) {
    if (isSignal(cur)) cur = cur()
    if (cur === null || typeof cur !== 'object') return { ok: false }
    if (!(key in (cur as object))) return { ok: false }
    cur = (cur as Record<string, unknown>)[key]
  }
  if (v.bindings.length) {
    if (typeof cur !== 'function') return { ok: false }
    const args = v.bindings.map((b) => scope[b])
    return { ok: true, value: (cur as (...a: unknown[]) => unknown)(...args) }
  }
  if (isSignal(cur)) cur = cur()
  return { ok: true, value: cur }
}

/** Like resolve but returns the member itself (for handlers and x-model signals). */
export function resolveMember(members: Record<string, unknown>, v: ParsedValue): unknown {
  let cur: unknown = members
  for (const key of v.path) {
    if (isSignal(cur)) cur = cur()
    if (cur === null || typeof cur !== 'object' || !(key in (cur as object))) return undefined
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}
