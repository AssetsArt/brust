import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { REPORT, renderReport, runBattery, type Result } from './run.ts'
import { rows } from './rows.ts'

const results = runBattery()   // one cargo build + 60 brustc runs, shared by the tests below

test('a snippet that does not parse is a compile-error row and does not abort the battery', () => {
  const r = results.find((x) => x.row.id === 'e-parse-error')!
  expect(r.observed).toBe('compile-error')
  expect(r.message).toMatch(/^Syntax Error \(input\.tsx:1:\d+\)$/)
  expect(results.length).toBe(rows.length)
})

test('report rows are fixed strings built from the row name, not machine paths or ids', () => {
  const pick = (id: string) => results.find((x) => x.row.id === id) as Result
  const report = renderReport([pick('a-static-text'), pick('c-usereducer')])
  const lines = report.split('\n').filter((l) => l.startsWith('| a-static-text') || l.startsWith('| c-usereducer'))
  expect(lines).toEqual([
    '| a-static-text | static text | static | static | 0 | — |  |',
    '| c-usereducer | useReducer | react | react | ssr | fallback:hook-unsupported |  |',
  ])
  const full = renderReport(results)
  expect(full).not.toMatch(/\/Users\/|\/tmp\/|\/var\/|input_[0-9a-f]{8}|battery-/)
})

test('the committed report equals a fresh run (CI diffs it too)', () => {
  expect(readFileSync(REPORT, 'utf8')).toBe(renderReport(results))
})
