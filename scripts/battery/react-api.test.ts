// R18.2: no react.dev entry without a battery row, and no row naming an entry that is not in the list.
import { expect, test } from 'bun:test'
import { apiCoverage, NOT_APPLICABLE, renderApiSection, statusOf } from './api-coverage.ts'
import { API_GROUPS, FETCHED, REACT_API } from './react-api.ts'
import { rows, type Row } from './rows.ts'
import type { Result } from './run.ts'

test('react-api.ts: unique names, known groups, react.dev URLs, a fetch date', () => {
  const names = REACT_API.map((e) => e.name)
  expect(new Set(names).size).toBe(names.length)
  for (const e of REACT_API) {
    expect(Object.keys(API_GROUPS)).toContain(e.group)
    expect(e.url.startsWith('https://react.dev/reference/')).toBe(true)
  }
  expect(FETCHED).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  // every group is used, so an empty group cannot hide a missing list
  for (const g of Object.keys(API_GROUPS)) expect(REACT_API.some((e) => e.group === g)).toBe(true)
})

test('battery row ids are unique', () => {
  const ids = rows.map((r) => r.id)
  expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([])
})

test('every react.dev entry has at least one battery row', () => {
  const missing = REACT_API.filter((e) => !rows.some((r) => r.api?.includes(e.name))).map((e) => e.name)
  expect(missing).toEqual([])
})

test('every row `api` names an entry of react-api.ts', () => {
  const known = new Set(REACT_API.map((e) => e.name))
  const bad = rows.flatMap((r) => (r.api ?? []).filter((a) => !known.has(a)).map((a) => `${r.id}: ${a}`))
  expect(bad).toEqual([])
})

test('NOT_APPLICABLE names only entries of the list', () => {
  const known = new Set(REACT_API.map((e) => e.name))
  expect(Object.keys(NOT_APPLICABLE).filter((n) => !known.has(n))).toEqual([])
})

test('statusOf: the status table', () => {
  expect(statusOf(['static'])).toBe('static')
  expect(statusOf(['native'])).toBe('native')
  expect(statusOf(['static', 'native'])).toBe('native')
  expect(statusOf(['react'])).toBe('island')
  expect(statusOf(['native', 'react'])).toBe('partial')
  expect(statusOf(['static', 'react', 'error'])).toBe('partial')
  expect(statusOf(['native', 'error'])).toBe('partial')
  expect(statusOf(['error'])).toBe('unsupported')
  expect(statusOf(['compile-error'])).toBe('unsupported')
  expect(statusOf(['react', 'error'])).toBe('partial')
})

const fake = (id: string, api: string[], observed: Result['observed'], note?: string): Result =>
  ({ row: { id, category: 'C', authoring: id, snippet: '', expect: observed as never, api, note } as unknown as Row, observed, jobs: [], diagnostics: observed === 'react' ? ['fallback:x'] : [], build: 'ok', built: true, rawSinks: 0, runtime: { features: [], needed: false }, warn: false })

test('apiCoverage: rows, tiers, diagnostics and a one-line note per entry', () => {
  const res = [fake('a', ['useState'], 'native', 'spec'), fake('b', ['useState'], 'react'), fake('c', ['useReducer'], 'react')]
  const c = apiCoverage(res, REACT_API.filter((e) => ['useState', 'useReducer', "'use client'"].includes(e.name)))
  const by = Object.fromEntries(c.map((e) => [e.name, e]))
  expect(by.useState).toMatchObject({ status: 'partial', rows: ['a', 'b'], tiers: ['native', 'react'], diagnostics: ['fallback:x'] })
  expect(by.useState?.note).toBe('native/static: a; island: b')
  expect(by.useReducer).toMatchObject({ status: 'island', rows: ['c'] })
  expect(by["'use client'"]?.status).toBe('n/a')
  expect(by["'use client'"]?.note).toContain('No directives')
})

test('renderApiSection lists every entry once, grouped', () => {
  const md = renderApiSection(rows.map((r) => fake(r.id, r.api ?? [], 'react')))
  for (const e of REACT_API) expect(md.split(`[\`${e.name}\`](${e.url})`).length - 1).toBe(1)
  expect(md).toContain('## By React API')
})
