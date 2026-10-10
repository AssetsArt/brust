import { expect, test } from 'bun:test'
import { isStale, parseLock } from './lock'

test('parseLock reads "<slug> <agent> <ISO>" and rejects anything else', () => {
  expect(parseLock('m3b-bench-suite knock2 2026-10-10T01:20:00.000Z')).toEqual({ owner: 'm3b-bench-suite knock2', at: '2026-10-10T01:20:00.000Z' })
  expect(parseLock(null)).toBeNull()
  expect(parseLock('garbage')).toBeNull()
})
test('a lock older than 20 minutes is stale, a fresh one is not', () => {
  const now = Date.parse('2026-10-10T02:00:00Z')
  expect(isStale({ owner: 'a b', at: '2026-10-10T01:30:00Z' }, now)).toBe(true)
  expect(isStale({ owner: 'a b', at: '2026-10-10T01:50:00Z' }, now)).toBe(false)
  expect(isStale({ owner: 'a b', at: 'not-a-date' }, now)).toBe(true)
})
