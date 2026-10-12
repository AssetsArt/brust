import { describe, expect, test } from 'bun:test'
import fixture from './fixtures/results.json'
import { computeVerdict, renderMarkdown, renderVerdict, type Results, rpsOf } from './report'

const r = fixture as unknown as Results
const without01x: Results = { ...r, header: { ...r.header, apps: ['brust', 'bun-serve', 'next'], skipped: [{ app: 'brust-01x', reason: 'BRUST_01X_DIR unset' }] }, measurements: r.measurements.filter((m) => m.app !== 'brust-01x') }

describe('computeVerdict', () => {
  test('F68: v2 vs 0.1.x on D and I, identity; MET only when both ≥ 0', () => {
    const v = computeVerdict(r)
    expect(v.f68.d).toBeCloseTo(11.111, 2)
    expect(v.f68.i).toBeCloseTo(-4.762, 2)
    expect(v.f68.met).toBe(false)
    expect(computeVerdict({ ...r, measurements: r.measurements.map((m) => (m.app === 'brust-01x' && m.probe === 'I' ? { ...m, nums: { ...m.nums, rps: 40000 } } : m)) }).f68.met).toBe(true)
  })
  test('sanity: v2 / next per probe, MET when every ratio ≥ 2', () => {
    const v = computeVerdict(r)
    expect(v.sanity.s).toBeCloseTo(9.2, 3)
    expect(v.sanity.d).toBeCloseTo(3.3333, 3)
    expect(v.sanity.i).toBeCloseTo(3.3333, 3)
    expect(v.sanity.met).toBe(true)
    expect(computeVerdict({ ...r, measurements: r.measurements.map((m) => (m.app === 'next' && m.probe === 'I' ? { ...m, nums: { ...m.nums, rps: 30000 } } : m)) }).sanity.met).toBe(false)
  })
  test('ceiling: v2 / bun-serve in percent on D and I', () => {
    const v = computeVerdict(r)
    expect(v.ceiling.d).toBeCloseTo(83.333, 2)
    expect(v.ceiling.i).toBeCloseTo(61.538, 2)
  })
  test('a skipped app yields nulls, never NaN, and met = null', () => {
    const v = computeVerdict(without01x)
    expect(v.f68).toEqual({ d: null, i: null, met: null })
    expect(rpsOf(without01x, 'brust-01x', 'D')).toBeNull()
    expect(rpsOf(r, 'brust', 'D', 'gzip')).toBe(48000)
  })
})

describe('renderVerdict', () => {
  test('the three lines, byte-exact (spec §1.5)', () => {
    expect(renderVerdict(computeVerdict(r))).toBe(
      ['bar F68  : v2 vs 0.1.x  D +11.1%  I -4.8%   → NOT MET', 'sanity   : v2 vs next   S ×9.2  D ×3.3  I ×3.3   → MET (≥ 2×)', 'ceiling  : v2 / bun-serve  D 83.3%  I 61.5%        (target D ≥ 80%)'].join('\n'),
    )
  })
  test('an unbalanced reusePort labels the ceiling 1-proc instead of comparing budgets silently', () => {
    const line = renderVerdict(computeVerdict({ ...r, header: { ...r.header, bunServeBalanced: false } })).split('\n')[2]
    expect(line).toBe('ceiling  : v2 / bun-serve (1-proc: reusePort did not balance)  D 83.3%  I 61.5%        (target D ≥ 80%)')
  })
  test('missing 0.1.x → NOT MEASURED, dashes instead of numbers', () => {
    expect(renderVerdict(computeVerdict(without01x)).split('\n')[0]).toBe('bar F68  : v2 vs 0.1.x  D —  I —   → NOT MEASURED')
  })
})

describe('renderMarkdown', () => {
  test('header fields, one table per probe with identity + gzip columns, the verdict block, no prose', () => {
    const md = renderMarkdown(r)
    expect(md).toContain('# bench — 2026-10-10')
    expect(md).toContain('seed 12345')
    expect(md).toContain('load 3.1 4.2 4.0 (10 cores)')
    expect(md).toContain('next 16.4.0')
    expect(md).toContain('budgets brust workers=10, bun-serve procs=10, next procs=1 (as shipped), brust-01x workers=10')
    expect(md).toContain('## S — `/types`')
    expect(md).toContain('| brust | 50,000 | 2.30 | 4.00 | 5.10 | 0 | 21,000 | 48,000 | 2.40 | 5.30 | 21,000 |')   // D row: identity then gzip
    expect(md).toContain('| next | 12,000 | 9.90 | 14.00 | 18.00 | 2 | 21,000 | — | — | — | — |')            // I row: no gzip pass
    expect(md).toContain('bar F68  : v2 vs 0.1.x  D +11.1%  I -4.8%   → NOT MET')
    expect(md).not.toMatch(/The gzip columns are|not slower|Bar \(/)                              // no hand-written sentences
    expect(renderMarkdown(without01x)).toContain('skipped: brust-01x (BRUST_01X_DIR unset)')
  })
})

import actionsFixture from './fixtures/results-actions.json'
import { computeActionsVerdict, mergeResults, renderActionsVerdict } from './report'

const ra = actionsFixture as unknown as Results

describe('actions (A1/A2)', () => {
  test('(a) no actions block → no Actions section', () => {
    expect(renderMarkdown(r)).not.toContain('## Actions')
  })
  test('(b) Actions section: one table per A probe, 3-decimal latencies, four rows', () => {
    const md = renderMarkdown(ra)
    expect(md).toContain('## Actions')
    expect(md).toContain('### A1 — `GET /_brust/action/types`')
    expect(md).toContain('### A2 — `POST /_brust/action/team`')
    expect(md).toContain('| app | conn | rps | p50 ms | p95 ms | p99 ms | errors | bytes/resp |')
    const a1 = md.slice(md.indexOf('### A1'), md.indexOf('### A2')).split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| app') )
    expect(a1.map((l) => l.split('|').slice(1, 3).map((c) => c.trim()).join(' '))).toEqual(['brust c=120', 'brust c=1', 'elysia-bun c=120', 'elysia-bun c=1'])
    expect(a1[1]).toContain('0.114')
    expect(md).toContain('SO_REUSEPORT') // the macOS caveat sits next to the numbers
  })
  test('(c) actions verdict line, byte-exact; unbalanced gets the 1-proc label', () => {
    expect(renderActionsVerdict(computeActionsVerdict(ra))).toBe('actions  : brust / elysia-bun (c=120)  A1 87.5%  A2 90.0%   · c=1 p50 brust − elysia-bun  A1 +14 µs  A2 +16 µs')
    const unbalanced = { ...ra, actions: { ...ra.actions!, header: { ...ra.actions!.header, elysiaBunBalanced: false } } }
    expect(renderActionsVerdict(computeActionsVerdict(unbalanced))).toContain('elysia-bun (1-proc: reusePort did not balance) (c=120)')
    expect(renderMarkdown(ra)).toContain('actions  : brust / elysia-bun (c=120)')
  })
  test('(d) merge: an A-only run keeps the page block, a page-only run keeps the actions', () => {
    const old = ra
    const aOnly = { header: { ...old.header, seed: 999 }, measurements: [], actions: { ...old.actions!, header: { ...old.actions!.header, seed: 5 } } } as Results
    const m1 = mergeResults(old, aOnly, { page: false, actions: true })
    expect(m1.header).toEqual(old.header)
    expect(m1.measurements).toEqual(old.measurements)
    expect(m1.actions!.header.seed).toBe(5)
    const pageOnly = { header: { ...old.header, seed: 42 }, measurements: [old.measurements[0]!] } as Results
    const m2 = mergeResults(old, pageOnly, { page: true, actions: false })
    expect(m2.header.seed).toBe(42)
    expect(m2.actions).toEqual(old.actions)
  })
  test('(e) merge leaves .measurements byte-identical; no old page block → run header with []', () => {
    const aOnly = { header: r.header, measurements: [], actions: ra.actions } as Results
    expect(JSON.stringify(mergeResults(r, aOnly, { page: false, actions: true }).measurements)).toBe(JSON.stringify(r.measurements))
    const fresh = mergeResults(undefined, aOnly, { page: false, actions: true })
    expect(fresh.measurements).toEqual([])
    expect(fresh.header).toEqual(r.header)
  })
})
