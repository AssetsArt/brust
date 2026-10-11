// examples/pokedex/test/team-db.test.ts — the sqlite roster (M3-F E7): MAX 6, idempotent add, shared file, lazy open.
import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { artwork } from '../lib/pokeapi'
import { openTeamDb, teamDb, teamDbPath } from '../lib/team-db'
import type { TeamMember } from '../lib/types'

const dir = mkdtempSync(join(tmpdir(), 'pokedex-team-db-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
let n = 0
const fresh = () => join(dir, `t${n++}.sqlite`)
const m = (id: number, types = ['normal']): TeamMember => ({ id, name: `p${id}`, displayName: `P${id}`, types, artwork: artwork(id), num: `#${String(id).padStart(4, '0')}` })

test('a fresh db lists nothing', () => {
  const db = openTeamDb(':memory:')
  expect(db.list()).toEqual([])
})

test('add returns added, then present for the same id; list keeps insertion order', () => {
  const db = openTeamDb(':memory:')
  expect(db.add(m(25))).toBe('added')
  expect(db.add(m(4))).toBe('added')
  expect(db.add(m(25))).toBe('present')
  expect(db.list().map((x) => x.id)).toEqual([25, 4])
})

test('the seventh distinct member is refused with full; an existing member is still present when full', () => {
  const db = openTeamDb(':memory:')
  for (const id of [1, 2, 3, 4, 5, 6]) expect(db.add(m(id))).toBe('added')
  expect(db.add(m(7))).toBe('full')
  expect(db.add(m(3))).toBe('present')
  expect(db.list()).toHaveLength(6)
})

test('remove deletes; removing an absent id is a no-op', () => {
  const db = openTeamDb(':memory:')
  db.add(m(1))
  db.add(m(2))
  expect(db.remove(1)).toBe(true)
  expect(db.remove(1)).toBe(false)
  expect(db.list().map((x) => x.id)).toEqual([2])
})

test('a second connection to the same file sees the rows (workers share one file)', () => {
  const f = fresh()
  const a = openTeamDb(f)
  const b = openTeamDb(f)
  a.add(m(9))
  expect(b.list().map((x) => x.id)).toEqual([9])
  b.add(m(10))
  expect(a.list().map((x) => x.id)).toEqual([9, 10])
  a.close()
  b.close()
})

test('rows survive close + reopen (restart keeps the team)', () => {
  const f = fresh()
  const a = openTeamDb(f)
  a.add(m(1))
  a.add(m(2))
  a.close()
  const b = openTeamDb(f)
  expect(b.list().map((x) => x.id)).toEqual([1, 2])
  b.close()
})

test('types round-trip as an array', () => {
  const db = openTeamDb(':memory:')
  db.add(m(1, ['grass', 'poison']))
  expect(db.list()[0]).toEqual(m(1, ['grass', 'poison']))
})

test('teamDb() honours POKEDEX_TEAM_DB, creates the parent dir, and is a per-process singleton', () => {
  const f = join(dir, 'nested/deeper/team.sqlite')
  const prev = process.env.POKEDEX_TEAM_DB
  process.env.POKEDEX_TEAM_DB = f
  try {
    expect(teamDbPath()).toBe(f)
    const a = teamDb()
    expect(teamDb()).toBe(a)
    expect(existsSync(f)).toBe(true)
    a.close()
  } finally {
    if (prev === undefined) delete process.env.POKEDEX_TEAM_DB
    else process.env.POKEDEX_TEAM_DB = prev
  }
})

test('importing lib/loaders.ts opens no database', async () => {
  const f = join(dir, 'lazy.sqlite')
  const prev = process.env.POKEDEX_TEAM_DB
  process.env.POKEDEX_TEAM_DB = f
  try {
    await import('../lib/loaders')
    expect(existsSync(f)).toBe(false)
  } finally {
    if (prev === undefined) delete process.env.POKEDEX_TEAM_DB
    else process.env.POKEDEX_TEAM_DB = prev
  }
})
