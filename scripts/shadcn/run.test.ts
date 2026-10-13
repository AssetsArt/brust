import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { analysePage, pageNames } from './app.ts'
import { REPORT } from './paths.ts'
import { rankBlockers, renderReport } from './report.ts'
import { survey } from './run.ts'

const { rows, libs } = survey() // one build per page: shared by the tests below

test('the committed scoreboard equals a fresh run (CI diffs it too)', () => {
  expect(readFileSync(REPORT, 'utf8')).toBe(renderReport(rows, libs))
})

test('the analysis is deterministic: a second compile of every page gives the same rows', () => {
  const again = pageNames().map((id) => analysePage(id))
  expect(again).toEqual(rows.map(({ build: _b, bundleBytes: _s, ...r }) => r))
})

test('every fixture page is a row, and every row has a tier', () => {
  expect(rows.map((r) => r.id)).toEqual(pageNames())
  for (const r of rows) expect(['static', 'native', 'react', 'error']).toContain(r.tier)
})

test('the doc names no machine path', () => {
  expect(renderReport(rows, libs)).not.toMatch(/\/Users\/|\/tmp\/|\/var\/|shadcn-lib-/)
})

test('the ranked list is sorted by blocked count and combines app and library blockers', () => {
  const ranked = rankBlockers(rows, libs)
  const total = (b: (typeof ranked)[number]) => b.appRows + b.libComponents
  for (let i = 1; i < ranked.length; i++) expect(total(ranked[i - 1]!)).toBeGreaterThanOrEqual(total(ranked[i]!))
  expect(ranked.some((b) => b.appRows > 0)).toBe(true)
  expect(ranked.some((b) => b.libComponents > 0)).toBe(true)
})
