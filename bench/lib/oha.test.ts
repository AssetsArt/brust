import { describe, expect, test } from 'bun:test'
import fixture from './fixtures/oha.json'
import { ohaArgs, parseOha, validateRun } from './oha'

describe('parseOha', () => {
  test('rps and latencies (seconds → ms) from the oha 1.x shape', () => {
    const r = parseOha(fixture)
    expect(r.rps).toBeCloseTo(61997.77, 1)
    expect(r.p50).toBeCloseTo(0.058958, 6)
    expect(r.p95).toBeCloseTo(0.103583, 6)
    expect(r.p99).toBeCloseTo(0.125375, 6)
  })
  test('total = sum of statusCodeDistribution; deadline truncation is not an error', () => {
    const r = parseOha(fixture)
    expect(r.total).toBe(62218)
    expect(r.errors).toBe(0)
  })
  test('real errors (connection / non-deadline) are counted', () => {
    const r = parseOha({ ...fixture, statusCodeDistribution: { '200': 10, '500': 2 }, errorDistribution: { 'connection refused': 4, 'aborted due to deadline': 1 } })
    expect(r.total).toBe(12)
    expect(r.errors).toBe(4)
  })
  test('a non-object input throws with the offending shape', () => {
    expect(() => parseOha('nope')).toThrow(/oha json/)
  })
})

describe('validateRun', () => {
  test('all-200 with no errors passes; bytes and status are read', () => {
    const r = parseOha(fixture)
    expect(r.bytes).toBe(49)
    expect(r.status).toEqual({ '200': 62218 })
    expect(() => validateRun(r, 'x')).not.toThrow()
  })
  test('a 500 response is not throughput', () => {
    const r = parseOha({ ...fixture, statusCodeDistribution: { '500': 62218 } })
    expect(() => validateRun(r, 'brust D')).toThrow(/brust D: not a valid measurement[\s\S]*"500":62218/)
  })
  test('connection errors fail it even with zero responses', () => {
    const r = parseOha({ ...fixture, statusCodeDistribution: {}, errorDistribution: { 'connection refused': 62218 } })
    expect(() => validateRun(r, 'x')).toThrow(/62218 transport errors/)
  })
})

describe('ohaArgs', () => {
  test('bar flags, encoding header, url last', () => {
    expect(ohaArgs('http://127.0.0.1:1/x', { conn: 120, dur: '10s', enc: 'identity' })).toEqual([
      '-c', '120', '-z', '10s', '--no-tui', '--output-format', 'json', '-m', 'GET', '-H', 'accept-encoding:identity', 'http://127.0.0.1:1/x',
    ])
    expect(ohaArgs('u', { conn: 1, dur: '3s', enc: 'gzip' })).toContain('accept-encoding:gzip')
  })
})
