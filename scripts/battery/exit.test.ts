// M1 exit criteria (spec §12), checked by code rather than by reading.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { EXIT_REPORT, REPORT, renderReport, runBattery } from './run.ts'
import { BROWSER_CASES, COMPILE_ERROR_ROWS, ERROR_ROWS, KNOWN_GAP_ROWS, renderExitReport } from './exit.ts'

const repo = resolve(import.meta.dir, '../..')
const results = runBattery()

test('the committed reports equal a fresh run', () => {
  expect(readFileSync(REPORT, 'utf8')).toBe(renderReport(results))
  expect(readFileSync(EXIT_REPORT, 'utf8')).toBe(renderExitReport(results))
})

test('no row disagrees with the spec unless it is a pinned known gap', () => {
  const bad = results.filter((r) => r.warn).map((r) => `${r.row.id}: expected ${r.row.expect}, observed ${r.observed}`)
  expect(bad).toEqual([])
  // The exemption set is pinned: adding, removing or silently fixing a gap changes this test.
  expect(results.filter((r) => r.row.knownGap).map((r) => r.row.id).sort()).toEqual(Object.keys(KNOWN_GAP_ROWS).sort())
  for (const [id, gap] of Object.entries(KNOWN_GAP_ROWS)) {
    const r = results.find((x) => x.row.id === id)!
    expect([id, r.observed]).toEqual([id, gap.observed])
    expect([id, r.row.knownGap!.includes(gap.ledger)]).toEqual([id, true])
  }
})

test('error rows are pinned and refuse to build; compile-error rows are pinned', () => {
  expect(results.filter((r) => r.row.expect === 'error').map((r) => r.row.id).sort()).toEqual([...ERROR_ROWS].sort())
  for (const r of results.filter((x) => x.row.expect === 'error')) expect([r.row.id, r.build]).toEqual([r.row.id, 'refused'])
  expect(results.filter((r) => r.row.expect === 'compile-error').map((r) => r.row.id).sort()).toEqual([...COMPILE_ERROR_ROWS].sort())
})

test('every react row has a fallback diagnostic and no error', () => {
  for (const r of results.filter((x) => x.observed === 'react')) {
    expect([r.row.id, r.diagnostics.some((d) => d.startsWith('fallback:'))]).toEqual([r.row.id, true])
    expect([r.row.id, r.diagnostics.some((d) => d.startsWith('error:'))]).toEqual([r.row.id, false])
  }
})

test('dual evaluation: server paint equals client initial values for every fixture', () => {
  const p = spawnSync('cargo', ['test', '-q', '-p', 'brust-compiler', '--test', 'dual_eval'], { cwd: repo, encoding: 'utf8' })
  expect(p.status, p.stdout + p.stderr).toBe(0)
}, 900_000)   // a cold CI cache compiles the test binaries first

test('every example harness passes in the browser harness', () => {
  const p = spawnSync('bun', ['test', '--timeout', '120000', 'tests/browser'], { cwd: repo, encoding: 'utf8' })
  const out = p.stdout + p.stderr
  expect(p.status, out).toBe(0)
  // One file per example, plus tests/browser/cases/harness-self-test.test.ts (the harness's negative control,
  // not a spec example, so it is not in BROWSER_CASES); a passing run does not name its files when piped.
  expect(out).toMatch(new RegExp(`across ${BROWSER_CASES.length + 1} files`))
  expect(out).toMatch(/ 0 fail/)
}, 600_000)
