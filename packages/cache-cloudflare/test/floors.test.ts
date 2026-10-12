import { expect, test } from 'bun:test'
import { Floors, namesOf } from '../src/floors'

test('raise keeps the max; floorOf covers tags and the path (GET by default)', () => {
  const f = new Floors()
  f.raise('t:a', 5); f.raise('t:a', 3)
  f.raiseArgs({ path: '/p' }, 7)
  expect(f.floorOf(['a'], 'POST', '/q')).toBe(5)
  expect(f.floorOf([], 'GET', '/p')).toBe(7)
  expect(f.floorOf([], 'POST', '/p')).toBe(0)
  expect(namesOf({ tags: ['a'], path: '/p', method: 'POST' })).toEqual(['t:a', 'p:POST /p'])
})
test('LRU eviction raises `evicted`, and an unknown name is only as safe as it', () => {
  const f = new Floors(2)
  f.raise('t:a', 1); f.raise('t:b', 2); f.raise('t:c', 3)
  expect(f.evicted).toBe(1)
  expect(f.floorOf(['zzz'], 'GET', '/')).toBe(1)
  f.seed({ names: [['t:x', 9]], evicted: 4 })
  expect(f.floorOf(['x'], 'GET', '/')).toBe(9)
  expect(f.floorOf(['y'], 'GET', '/')).toBe(4)
})
