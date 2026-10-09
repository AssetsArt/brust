// M1 exit criteria (spec §12), checked by code rather than by reading.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { EXIT_REPORT, REPORT, renderReport, runBattery } from './run.ts'
import { BROWSER_CASES, renderExitReport } from './exit.ts'

const repo = resolve(import.meta.dir, '../..')
const results = runBattery()

test('the committed reports equal a fresh run', () => {
  expect(readFileSync(REPORT, 'utf8')).toBe(renderReport(results))
  expect(readFileSync(EXIT_REPORT, 'utf8')).toBe(renderExitReport(results))
})

test('no row disagrees with the spec unless it is a documented known gap', () => {
  const bad = results.filter((r) => r.warn).map((r) => `${r.row.id}: expected ${r.row.expect}, observed ${r.observed}`)
  expect(bad).toEqual([])
  for (const r of results.filter((x) => x.row.knownGap)) expect(r.row.knownGap!.length).toBeGreaterThan(10)
})

test('every row expected native/static compiles so, with the expected job count', () => {
  for (const r of results.filter((x) => (x.row.expect === 'native' || x.row.expect === 'static') && !x.row.knownGap)) {
    expect([r.row.id, r.observed]).toEqual([r.row.id, r.row.expect])
    if (r.row.jobs !== undefined) expect([r.row.id, r.jobs.length]).toEqual([r.row.id, r.row.jobs])
  }
})

test('every react row has a fallback diagnostic and no error; every error row has an Error', () => {
  for (const r of results.filter((x) => x.observed === 'react')) {
    expect([r.row.id, r.diagnostics.some((d) => d.startsWith('fallback:'))]).toEqual([r.row.id, true])
    expect([r.row.id, r.diagnostics.some((d) => d.startsWith('error:'))]).toEqual([r.row.id, false])
  }
  for (const r of results.filter((x) => x.observed === 'error')) {
    expect([r.row.id, r.diagnostics.some((d) => d.startsWith('error:'))]).toEqual([r.row.id, true])
  }
})

test('dual evaluation: server paint equals client initial values for every fixture', () => {
  const p = spawnSync('cargo', ['test', '-q', '-p', 'brust-compiler', '--test', 'dual_eval'], { cwd: repo, encoding: 'utf8' })
  expect(p.status, p.stdout + p.stderr).toBe(0)
})

test('every example harness passes in the browser harness', () => {
  const p = spawnSync('bun', ['test', 'tests/browser'], { cwd: repo, encoding: 'utf8' })
  const out = p.stdout + p.stderr
  expect(p.status, out).toBe(0)
  // One file per example; a passing run does not name its files when piped.
  expect(out).toMatch(new RegExp(`across ${BROWSER_CASES.length} files`))
  expect(out).toMatch(/ 0 fail/)
})
