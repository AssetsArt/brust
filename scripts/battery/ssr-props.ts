// F386: the props a battery row's root component gets in the first-HTML comparison (served page and React's renderToString).
// Overrides by row id (list/object shapes the row indexes into) win; every other prop the root reads (`function C({ a, b })` or
// `props.a`) gets a fixed sample by NAME, so a row that only reads props is not compared as "undefined on both sides".
import type { Row } from './rows.ts'

const ITEMS = [{ id: 1, name: 'alpha', price: 3.5, k: 'k1', v: 'v1' }, { id: 2, name: 'beta', price: 10, k: 'k2', v: 'v2' }]
const ROWS = [{ id: 1, cells: ['a', 'b'], t: 'x', l: 'L1', c: 'red' }, { id: 2, cells: ['c'], t: 'y', l: 'L2', c: 'blue' }]

const OVERRIDES: Record<string, Record<string, unknown>> = {
  'a-list-cond-element': { xs: [{ id: 1, href: '/a', t: 'A' }, { id: 2, t: 'B' }] },
  'a-list-cond-state': { xs: [{ id: 1, href: '/a', t: 'A' }, { id: 2, t: 'B' }] },
  'a-list-keys': { items: ITEMS },
  'a-nested-list': { rows: ROWS },
  'b-island-in-inlined-row': { items: ITEMS },
  'b-island-per-row-in-inlined-component': { rows: ['p', 'q'] },
  'b-fed-child-prop-is-a-job-output': { x: 'abc' },
  'b-fed-child-row-invariant-props': { items: ITEMS },
  'b-fed-child-row-invariant-xfor': { items: ITEMS },
  'b-context-helper': { v: 40 },
  'a-plus-js-semantics': { s: 'a', n: 2 },
  'd-cache': { id: 'abcd' },
  'd-fragment-keyed': { items: ITEMS },
  'e-precompute-props': { price: 3.14159 },
  'e-precompute-per-item': { items: ITEMS },
  'e-static-list-child': { rows: ROWS },
  'e-reactive-list-child': { rows: ROWS },
}

const BY_NAME: Record<string, unknown> = {
  label: 'L', on: true, n: 3, tone: 'warn', className: 'k', title: 'T', name: 'N', text: 'tx', color: 'red', url: '/u', href: '/h',
  ok: true, show: true, open: true, checked: true, value: 'v', max: 5, id: 'i1', html: '<b>x</b>', a: 'A', b: 'B', c: 'C', d: 'D', t: 'T',
  v: 'V', x: 'X', o: 'O', dir: 'rtl',
}

/** The prop names the row's root component reads. */
export function readProps(snippet: string): string[] {
  const out = new Set<string>()
  for (const g of snippet.matchAll(/export default function \w+\(\{ ([^}]*)\}/g)) {
    for (const n of g[1]!.split(',')) {
      const name = n.trim().split(':')[0]!.split('=')[0]!.trim()
      if (name && !name.startsWith('...') && name !== 'children') out.add(name)
    }
  }
  for (const m of snippet.matchAll(/\bprops\.(\w+)/g)) out.add(m[1]!)
  return [...out]
}

export function ssrProps(row: Row): Record<string, unknown> {
  const o = OVERRIDES[row.id]
  if (o) return o
  const props: Record<string, unknown> = {}
  for (const n of readProps(row.snippet)) if (n in BY_NAME) props[n] = BY_NAME[n]
  return props
}
