import { expect, test } from 'bun:test'
import { Ring } from '../src/ring'

test('seqs run on from startSeq + 1; since returns only newer events', () => {
  const r = new Ring('g', 10)
  expect([r.publish({ tags: ['a'] }, 'o'), r.publish({ tags: ['b'] }, 'o')]).toEqual([11, 12])
  const s = r.since(11)
  expect(s.behind).toBe(false)
  expect(s.events.map((e) => e.seq)).toEqual([12])
  expect(r.since(12)).toMatchObject({ behind: false, events: [], seq: 12, gen: 'g' })
})
test('behind the ring: cap 4, publish 6', () => {
  const r = new Ring('g', 0, 4)
  for (let i = 0; i < 6; i++) r.publish({ tags: [`t${i}`] }, 'o')
  expect(r.since(1).behind).toBe(true)
  expect(r.since(2).events.map((e) => e.seq)).toEqual([3, 4, 5, 6])
})
test('the bytes cap drops the oldest; an event over 64 KiB is a clear marker; ahead of seq is behind', () => {
  const r = new Ring('g', 0, 1024, 600)
  for (let i = 0; i < 10; i++) r.publish({ tags: ['x'.repeat(100)] }, 'o')
  expect(r.since(0).behind).toBe(true)
  const r2 = new Ring('g')
  r2.publish({ tags: ['a'] }, 'o')
  r2.publish({ tags: ['x'.repeat(70_000)] }, 'o')
  r2.publish({ tags: ['b'] }, 'o')
  expect(r2.since(0).behind).toBe(true)
  expect(r2.since(2)).toMatchObject({ behind: false })
  expect(r2.since(99).behind).toBe(true)
})
