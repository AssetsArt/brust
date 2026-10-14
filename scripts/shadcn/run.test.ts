import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { analysePage, pageNames } from './app.ts'
import { REPORT, REPORT_JSON } from './paths.ts'
import { renderJson } from './json.ts'
import { RANKING_RULE, byRule, rankBlockers, renderReport } from './report.ts'
import { SIZES, survey } from './run.ts'

const { rows, libs, repro } = survey() // one build per page: shared by the tests below

test('the committed scoreboard equals a fresh run (CI diffs it too)', () => {
  expect(readFileSync(REPORT, 'utf8')).toBe(renderReport(rows, libs, repro))
})

test('the committed JSON equals a fresh run and agrees with the markdown', () => {
  expect(readFileSync(REPORT_JSON, 'utf8')).toBe(renderJson(rows, libs))
  const j = JSON.parse(renderJson(rows, libs))
  expect(j.rows.length).toBe(rows.length)
  expect(j.summary.measured + j.summary.analysisOnly).toBe(j.summary.pages)
  expect(j.summary.tier.static + j.summary.tier.native + j.summary.tier.react).toBe(j.summary.measured)
  expect(JSON.stringify(j)).not.toMatch(/\/Users\/|\/tmp\/|shadcn-sizes/)
})

test('the analysis is deterministic: a second compile of every page gives the same rows', () => {
  const again = pageNames().map((id) => analysePage(id))
  expect(again).toEqual(rows.map(({ build: _b, ...r }) => r))
})

test('every fixture page is a row, and every row has a tier', () => {
  expect(rows.map((r) => r.id)).toEqual(pageNames())
  for (const r of rows) expect(['static', 'native', 'react', 'error']).toContain(r.tier)
})

test('the doc names no machine path', () => {
  expect(renderReport(rows, libs, repro)).not.toMatch(/\/Users\/|\/tmp\/|\/var\/|shadcn-lib-/)
})

test('the ranked list follows the stated rule: measured rows, analysis-only rows, library components, name', () => {
  const ranked = rankBlockers(rows, libs)
  for (let i = 1; i < ranked.length; i++) {
    const [a, b] = [ranked[i - 1]!, ranked[i]!]
    expect(byRule(a, b)).toBeLessThanOrEqual(0)
    expect(a.measuredRows).toBeGreaterThanOrEqual(b.measuredRows)
    if (a.measuredRows === b.measuredRows) expect(a.analysisRows).toBeGreaterThanOrEqual(b.analysisRows)
    if (a.measuredRows === b.measuredRows && a.analysisRows === b.analysisRows) expect(a.libComponents).toBeGreaterThanOrEqual(b.libComponents)
  }
  expect(renderReport(rows, libs, repro)).toContain(RANKING_RULE)
  expect(ranked.some((b) => b.measuredRows > 0)).toBe(true)
  expect(ranked.some((b) => b.libComponents > 0)).toBe(true)
})

test('the repro guards the named-export rule (S1.1): a named-export island builds like a default one', () => {
  const by = Object.fromEntries(repro.map((r) => [r.id, r.build.ok]))
  expect(by).toEqual({ named: true, default: true, static: true })
})

test('measured and analysis-only rows add up, and the doc rounds client JS to KB with an exact 0', () => {
  const built = rows.filter((r) => r.build.ok)
  const refused = rows.filter((r) => !r.build.ok)
  expect(built.length + refused.length).toBe(rows.length)
  for (const r of built) {
    if (!r.build.ok) continue
    const m = r.build.measured
    expect(m.jsGzip === 0).toBe(m.islands === 0 && m.nativeChunks === 0)
    expect(m.jsGzip).toBeLessThanOrEqual(m.jsRaw)
  }
  const doc = renderReport(rows, libs, repro)
  expect(doc).toContain(`### Measured (${built.length} of ${rows.length} pages built)`)
  expect(doc).toContain(`### Analysis-only (${refused.length} of ${rows.length} pages refused)`)
  // R34.58: island-prop demotes the host to React, so no fixture page is refused (the section stays, empty).
  expect(refused.map((r) => r.id)).toEqual([])
})

test('a page that ships an island counts the runtime core and the rt-* modules it preloads (L33)', () => {
  const island = rows.find((r) => r.build.ok && r.build.measured.islands > 0)
  expect(island).toBeDefined()
  const names = (island!.build.ok ? island!.build.measured.files : []).map((f) => f.name)
  expect(names).toContain('runtime.js')
  expect(names).toContain('rt-island.js')
  // a feature the page's components do not use is not counted
  expect(names.filter((n) => /^rt-(for|if|model|html)\.js$/.test(n)).length).toBeLessThan(4)
})

test('the exact sizes go to the git-ignored JSON, not the doc', () => {
  const j = JSON.parse(readFileSync(SIZES, 'utf8')) as { pages: { id: string; built: boolean; raw?: number; gzip?: number }[] }
  expect(j.pages.length).toBe(rows.length)
  expect(j.pages.filter((p) => p.built).every((p) => typeof p.gzip === 'number' && typeof p.raw === 'number')).toBe(true)
  expect(renderReport(rows, libs, repro)).not.toMatch(/"gzip"/)
})

// S1.4 (R34.34, a gate, no knownGap): `asChild ? Slot.Root : "host"` is resolved at its call site, so these pages are static
// HTML: no island, no JS, and no Radix Slot in any client chunk or in jobs.js.
const SLOT_FLIPPED = ['badge', 'badge-aslink', 'bubble', 'button', 'button-aschild', 'card', 'empty', 'item', 'marker']

test('the local-component rows are static pages with 0 islands, 0 JS and no Radix Slot in the dist (S1.4)', () => {
  for (const id of SLOT_FLIPPED) {
    const r = rows.find((x) => x.id === id)
    expect(r?.build.ok, id).toBe(true)
    if (!r?.build.ok) continue
    const m = r.build.measured
    expect({ id, tier: m.tier, islands: m.islands, gzip: m.jsGzip, slot: m.slotFiles }).toEqual({ id, tier: 'static', islands: 0, gzip: 0, slot: [] })
  }
})

test('the Slot check can fire: a page whose Radix island bundles the Slot lists its files (control)', () => {
  const dialog = rows.find((x) => x.id === 'dialog')
  expect(dialog?.build.ok && dialog.build.measured.slotFiles.length).toBeGreaterThan(0)
})
