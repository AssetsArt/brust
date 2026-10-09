import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { REPORT, classifyBuild, renderReport, runBattery, type Result } from './run.ts'
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
    '| a-static-text | static text | static | static | 0 | ok | — | spec §3.1 static tier |',
    '| c-usereducer | useReducer | react | react | ssr | ok | fallback:hook-unsupported |  |',
  ])
  const full = renderReport(results)
  expect(full).not.toMatch(/\/Users\/|\/tmp\/|\/var\/|input_[0-9a-f]{8}|battery-/)
})

test('the committed report equals a fresh run (CI diffs it too)', () => {
  expect(readFileSync(REPORT, 'utf8')).toBe(renderReport(results))
})

test('classifyBuild: ok, refused by an Error diagnostic, and failed (no diagnostic, panic)', () => {
  expect(classifyBuild(0, '', false)).toBe('ok')
  expect(classifyBuild(1, 'error list-key input.tsx:1:82 list items need a `key`', true)).toBe('refused')
  expect(classifyBuild(1, '', true)).toBe('failed')
  expect(classifyBuild(1, 'thread main panicked at x', true)).toBe('failed')
  expect(classifyBuild(1, 'something broke', false)).toBe('failed')
  expect(classifyBuild(101, "thread 'main' panicked at src/x.rs:1:1", true)).toBe('failed')
  expect(classifyBuild(1, "thread 'main' panicked at src/x.rs:1:1", true)).toBe('failed')
  expect(classifyBuild(null, '', true)).toBe('failed')
})

test('every row lowers: non-error rows build ok, error rows are refused, nothing failed', () => {
  expect(results.filter((r) => r.built && r.build === 'failed').map((r) => r.row.id)).toEqual([])
  expect(results.filter((r) => r.built && r.build === 'refused').map((r) => r.row.id).sort()).toEqual(
    results.filter((r) => r.observed === 'error').map((r) => r.row.id).sort())
})
