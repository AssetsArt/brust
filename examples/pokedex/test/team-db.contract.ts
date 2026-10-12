// examples/pokedex/test/team-db.contract.ts — ONE behaviour suite for every TeamDb: sqlite (test/team-db.test.ts) and
// real D1 under local workerd (tests/cf/team-db-d1.test.ts). Not a *.test.* file: the callers register it.
import { describe, expect, test } from 'bun:test'
import { artwork } from '../lib/pokeapi'
import type { TeamDb } from '../lib/team-db'
import type { TeamMember } from '../lib/types'

const m = (id: number, types = ['normal']): TeamMember => ({ id, name: `p${id}`, displayName: `P${id}`, types, artwork: artwork(id), num: `#${String(id).padStart(4, '0')}` })

export function teamDbContract(label: string, fresh: () => Promise<TeamDb>): void {
  describe(`TeamDb contract: ${label}`, () => {
    test('every method returns a Promise', async () => {
      const db = await fresh()
      expect(db.list()).toBeInstanceOf(Promise)
      expect(db.add(m(1))).toBeInstanceOf(Promise)
      expect(db.remove(1)).toBeInstanceOf(Promise)
    })

    test('a fresh db lists nothing', async () => {
      const db = await fresh()
      expect(await db.list()).toEqual([])
    })

    test('add returns added, then present for the same id; list keeps insertion order', async () => {
      const db = await fresh()
      expect(await db.add(m(25))).toBe('added')
      expect(await db.add(m(4))).toBe('added')
      expect(await db.add(m(25))).toBe('present')
      expect((await db.list()).map((x) => x.id)).toEqual([25, 4])
    })

    test('the seventh distinct member is refused with full; an existing member is still present when full', async () => {
      const db = await fresh()
      for (const id of [1, 2, 3, 4, 5, 6]) expect(await db.add(m(id))).toBe('added')
      expect(await db.add(m(7))).toBe('full')
      expect(await db.add(m(3))).toBe('present')
      expect(await db.list()).toHaveLength(6)
    })

    test('remove deletes; removing an absent id is a no-op', async () => {
      const db = await fresh()
      await db.add(m(1))
      await db.add(m(2))
      expect(await db.remove(1)).toBe(true)
      expect(await db.remove(1)).toBe(false)
      expect((await db.list()).map((x) => x.id)).toEqual([2])
    })

    test('types round-trip as an array', async () => {
      const db = await fresh()
      await db.add(m(1, ['grass', 'poison']))
      expect((await db.list())[0]).toEqual(m(1, ['grass', 'poison']))
    })

    test('20 concurrent adds of distinct ids land exactly 6 (14 full)', async () => {
      const db = await fresh()
      const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => db.add(m(i + 1))))
      expect(rs.filter((r) => r === 'added')).toHaveLength(6)
      expect(rs.filter((r) => r === 'full')).toHaveLength(14)
      expect(await db.list()).toHaveLength(6)
    })
  })
}
