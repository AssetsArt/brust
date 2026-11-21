// Case 13 (F597): one module per accepted load-time form, together: it only builds its own values when it loads, so
// the chunk that bundles it is left out of a page that draws no `forms` host.
import { BASE } from './base'
import { SITE } from './site'

const AREAS = [
  { id: 'a', scopes: ['x', 'y'], soon: false },
  { id: 'b', scopes: ['z'], soon: true },
]
const label = (s: string) => ({ s, n: s.length })

// D1: built-in collections of fresh data.
export const SKIP = new Set(['.git', 'node_modules'])
export const BY = new Map([
  ['a', 1],
  ['b', 2],
])
// D2: a spread of an imported literal array.
export const ALL = [...BASE, 'z']
// D3: array methods with inline callbacks; D4: a call of a pure function of this module.
export const GRANTABLE = AREAS.filter((a) => !a.soon).flatMap((a) => a.scopes)
export const LABELS = GRANTABLE.map((s) => label(s))
// Extra rule 1: a template of an imported primitive const.
export const TERMS = `${SITE}/terms`

export function summary(): string {
  return `${GRANTABLE.join(',')} ${ALL.length} ${SKIP.has('.git')} ${BY.get('b')} ${LABELS.length} ${TERMS}`
}
