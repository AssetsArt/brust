// F386: the `--check` verdict of ssr-compare: red on a row whose served HTML differs from React's, or whose server refused it, unless
// the allowlist explains it; and red on an allowlist entry that no longer differs (the fixing lane deletes it).
import type { Allowed } from './ssr-allowlist.ts'

export interface Verdict { id: string; status: string; detail?: string }

export function gate(outcomes: Verdict[], allowed: Record<string, Allowed>): string[] {
  const problems: string[] = []
  const byId = new Map(outcomes.map((o) => [o.id, o]))
  for (const o of outcomes) {
    if ((o.status === 'differ' || o.status === 'skip-served') && !allowed[o.id]) {
      problems.push(`${o.id}: ${o.status === 'differ' ? 'the served HTML differs from React' : 'the server refused the row'}\n  ${(o.detail ?? '').split('\n').join('\n  ')}`)
    }
  }
  for (const [id, a] of Object.entries(allowed)) {
    const o = byId.get(id)
    if (!a.row || !a.why) problems.push(`${id}: the allowlist entry needs a row and a reason`)
    if (!o) problems.push(`${id}: allowlisted (${a.row}) but no such battery row`)
    else if (o.status !== 'differ' && o.status !== 'skip-served') problems.push(`${id}: allowlisted (${a.row}) but now ${o.status}: delete its entry from ssr-allowlist.ts`)
  }
  return problems
}
