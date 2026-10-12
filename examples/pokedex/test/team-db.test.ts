// examples/pokedex/test/team-db.test.ts — the sqlite roster (M3-F E7): MAX 6, idempotent add, shared file, lazy open.
import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { artwork } from '../lib/pokeapi'
import { openTeamDb, teamDb, teamDbPath } from '../lib/team-db'
import type { TeamMember } from '../lib/types'
import { teamDbContract } from './team-db.contract'

const dir = mkdtempSync(join(tmpdir(), 'pokedex-team-db-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
let n = 0
const fresh = () => join(dir, `t${n++}.sqlite`)
const m = (id: number, types = ['normal']): TeamMember => ({ id, name: `p${id}`, displayName: `P${id}`, types, artwork: artwork(id), num: `#${String(id).padStart(4, '0')}` })

teamDbContract('sqlite', async () => openTeamDb(':memory:'))

test('a second connection to the same file sees the rows (workers share one file)', async () => {
  const f = fresh()
  const a = openTeamDb(f)
  const b = openTeamDb(f)
  await a.add(m(9))
  expect((await b.list()).map((x) => x.id)).toEqual([9])
  await b.add(m(10))
  expect((await a.list()).map((x) => x.id)).toEqual([9, 10])
  a.close()
  b.close()
})

test('rows survive close + reopen (restart keeps the team)', async () => {
  const f = fresh()
  const a = openTeamDb(f)
  await a.add(m(1))
  await a.add(m(2))
  a.close()
  const b = openTeamDb(f)
  expect((await b.list()).map((x) => x.id)).toEqual([1, 2])
  b.close()
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
