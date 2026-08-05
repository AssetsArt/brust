import { expect, test } from 'bun:test'
import { formatCompilerWarning } from '../runtime/cli/native-routes-emit.ts'
import {
  BATTERY,
  NOT_INLINED,
  type Row,
  classify,
  filesFor,
  renderReport,
} from '../scripts/react-coverage.ts'

/** Unit cover for the coverage GENERATOR (scripts/react-coverage.ts). The
 * battery's compile results are the report's job; these cases guard the parts
 * that would silently corrupt it: duplicate ids, a snippet that never reaches
 * the compiler, a warning regex drifting away from the CLI's own parser, and
 * the classification/escaping rules the tables depend on. */

const ENTRIES = BATTERY.flatMap((category) => category.entries)

test('battery ids are unique and anchor-safe', () => {
  const ids = ENTRIES.map((e) => e.id)
  expect(new Set(ids).size).toBe(ids.length)
  for (const id of ids) expect(id).toMatch(/^[a-z]-[a-z0-9-]+$/)
})

test('every entry carries a marker and a why-it-matters note', () => {
  for (const entry of ENTRIES) {
    expect(entry.marker.length, `${entry.id} marker`).toBeGreaterThan(0)
    expect(entry.note.length, `${entry.id} note`).toBeGreaterThan(20)
    expect(
      entry.subject.includes('export default') || entry.subject.includes('export function'),
    ).toBe(true)
  }
})

test('both positions hand the compiler a Page.tsx that mounts the subject', () => {
  for (const entry of ENTRIES) {
    if (entry.componentPosition !== false) {
      const files = filesFor(entry, 'component')
      expect(files['Subject.tsx'], `${entry.id} subject file`).toBe(entry.subject)
      expect(files['Page.tsx'], `${entry.id} page`).toContain('<Subject ')
      expect(files['Page.tsx']).toContain(
        entry.importForm === 'named'
          ? "import { Subject } from './Subject'"
          : "import Subject from './Subject'",
      )
    }
    if (entry.routePosition !== false) {
      // The route run compiles the construct itself as the page.
      expect(filesFor(entry, 'route')['Page.tsx'], `${entry.id} route page`).toBe(entry.subject)
    }
  }
})

test('a call-site prop is always backed by a wrapper-route param', () => {
  for (const entry of ENTRIES) {
    if (entry.callProps === undefined) continue
    const name = entry.callProps.split('=')[0]!
    expect(entry.pageParams ?? '', `${entry.id} pageParams`).toContain(name)
  }
})

test('the fallback-warning regex still matches the CLI parser', () => {
  // Same input, two consumers: the CLI's guidance formatter and the report's
  // reason extractor. If the compiler's wording changes, both must move.
  const warning = 'native component "HookBadge" not inlined: component calls React hook `useState`'
  const match = NOT_INLINED.exec(warning)
  expect(match).not.toBeNull()
  expect(match?.[1]).toBe('HookBadge')
  expect(match?.[2]).toBe('component calls React hook `useState`')
  const formatted = formatCompilerWarning(warning)
  expect(formatted).toContain('native component "HookBadge" was not inlined')
  expect(formatted).toContain(`reason: ${match?.[2]}`)
  // A warning the CLI does NOT recognise must not be parsed as a fallback either.
  expect(NOT_INLINED.exec('ordinary compiler warning')).toBeNull()
  expect(formatCompilerWarning('ordinary compiler warning')).toBe(
    'brust: ordinary compiler warning',
  )
})

const BASE = ENTRIES[0]!

test('classify: inlined is INLINE unless the row declares a semantic gap', () => {
  const inlined = { observed: 'inlined' as const, reason: '' }
  expect(classify({ ...BASE, expected: 'inline' }, inlined, inlined).status).toBe('INLINE')
  expect(
    classify({ ...BASE, expected: 'gap', semanticGap: 'wrong position' }, inlined, inlined).status,
  ).toBe('GAP')
})

test('classify: a non-inlined row is a GAP unless it is fallback-by-design', () => {
  const fell = { observed: 'fallback' as const, reason: 'source unresolved' }
  expect(classify({ ...BASE, expected: 'gap' }, fell, fell).status).toBe('GAP')
  expect(classify({ ...BASE, expected: 'fallback-by-design' }, fell, fell).status).toBe(
    'FALLBACK-BY-DESIGN',
  )
  // An expectation that no longer matches reality is flagged, never rewritten.
  expect(classify({ ...BASE, expected: 'inline' }, fell, fell).mismatch).toBe(true)
  expect(classify({ ...BASE, expected: 'gap' }, fell, fell).mismatch).toBe(false)
})

test('classify: the route column is judged against expectedRoute', () => {
  const inlined = { observed: 'inlined' as const, reason: '' }
  const broke = { observed: 'error' as const, reason: 'body must be a single return' }
  expect(classify({ ...BASE, expectedRoute: 'ok' }, inlined, broke).routeMismatch).toBe(true)
  expect(classify({ ...BASE, expectedRoute: 'broken' }, inlined, broke).routeMismatch).toBe(false)
  expect(classify({ ...BASE, expectedRoute: 'broken' }, inlined, inlined).routeMismatch).toBe(true)
})

function row(overrides: Partial<Row> & { entry: Row['entry'] }): Row {
  return {
    category: 'A',
    component: { observed: 'inlined', reason: '' },
    route: { observed: 'inlined', reason: '' },
    status: 'INLINE',
    mismatch: false,
    routeMismatch: false,
    ...overrides,
  }
}

test('renderReport: gaps reach the backlog, and pipes never break a table', () => {
  const gap = row({
    entry: {
      ...BASE,
      id: 'x-piped',
      title: 'piped | title',
      note: 'a note with a | pipe in it, long enough to be a real note',
    },
    component: { observed: 'fallback', reason: 'reason with a | pipe' },
    route: { observed: 'error', reason: 'route blew up' },
    status: 'GAP',
  })
  const report = renderReport([gap], '9.9.9-test')

  expect(report).toContain('brustjs `9.9.9-test`')
  expect(report).toContain('## Gaps (backlog)')
  expect(report).toContain('[x-piped](#x-piped)')
  // Every table line keeps its 6 columns: pipes inside cells are escaped.
  for (const line of report.split('\n')) {
    if (!line.startsWith('| ') || line.startsWith('| ---')) continue
    const unescaped = line.replace(/\\\|/g, '')
    expect(unescaped.split('|').length, line).toBeLessThanOrEqual(8)
  }
  // No wall-clock anywhere — the report has to diff clean on re-runs.
  expect(report).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
})

test('renderReport: a route-only failure lands in its own section', () => {
  const routeOnly = row({
    entry: { ...BASE, id: 'x-route-only', title: 'route only', note: 'a note long enough to pass' },
    route: { observed: 'error', reason: 'unresolved identifier `ITEMS`' },
  })
  const report = renderReport([routeOnly], '9.9.9-test')
  expect(report).toContain('### Route-file-only gaps')
  expect(report).toContain('[x-route-only](#x-route-only)')
  expect(report).toContain('unresolved identifier')
})
