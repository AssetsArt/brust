import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { analysePage, pageNames } from './app.ts'
import { REPORT } from './paths.ts'
import { RANKING_RULE, byRule, rankBlockers, renderReport } from './report.ts'
import { survey } from './run.ts'

const { rows, libs, repro } = survey() // one build per page: shared by the tests below

test('the committed scoreboard equals a fresh run (CI diffs it too)', () => {
  expect(readFileSync(REPORT, 'utf8')).toBe(renderReport(rows, libs, repro))
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
  expect(renderReport(rows, libs, repro)).not.toMatch(/\/Users\/|\/tmp\/|\/var\/|shadcn-lib-/)
})

test('the ranked list follows the stated rule: app rows, then library components, then name', () => {
  const ranked = rankBlockers(rows, libs)
  for (let i = 1; i < ranked.length; i++) {
    const [a, b] = [ranked[i - 1]!, ranked[i]!]
    expect(byRule(a, b)).toBeLessThanOrEqual(0)
    expect(a.appRows).toBeGreaterThanOrEqual(b.appRows)
    if (a.appRows === b.appRows) expect(a.libComponents).toBeGreaterThanOrEqual(b.libComponents)
  }
  expect(renderReport(rows, libs, repro)).toContain(RANKING_RULE)
  // the build blocker (every page behind it) ranks first or second, never below blockers that hit fewer pages
  expect(ranked.findIndex((b) => b.kind === 'build')).toBeLessThan(2)
  expect(ranked.some((b) => b.appRows > 0)).toBe(true)
  expect(ranked.some((b) => b.libComponents > 0)).toBe(true)
})

test('the repro isolates the named-export rule: only the named-export island fails to build', () => {
  const by = Object.fromEntries(repro.map((r) => [r.id, r.build.ok]))
  expect(by).toEqual({ named: false, default: true, static: true })
})
