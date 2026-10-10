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
    expect(md).toContain('## S — `/types`')
    expect(md).toContain('| brust | 50,000 | 2.30 | 4.00 | 5.10 | 0 | 48,000 | 2.40 | 5.30 |')   // D row: identity then gzip
    expect(md).toContain('| next | 12,000 | 9.90 | 14.00 | 18.00 | 2 | — | — | — |')            // I row: no gzip pass
    expect(md).toContain('bar F68  : v2 vs 0.1.x  D +11.1%  I -4.8%   → NOT MET')
    expect(md).not.toMatch(/The gzip columns are|not slower|Bar \(/)                              // no hand-written sentences
    expect(renderMarkdown(without01x)).toContain('skipped: brust-01x (BRUST_01X_DIR unset)')
  })
})
