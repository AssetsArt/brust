// examples/pokedex/lib/team-db.ts — server-only (brust.toml [build] server_only). The team is ONE shared roster, as in
// 0.1.x, but persisted: every worker thread opens the same file (WAL), so workers never diverge (M3-F E7).
import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { MAX_TEAM } from './team'
import type { TeamMember } from './types'

export type AddResult = 'added' | 'present' | 'full'
export interface TeamDb {
  list(): TeamMember[]
  add(m: TeamMember): AddResult
  remove(id: number): boolean
  close(): void
}

interface Row { id: number; name: string; display_name: string; num: string; types: string; artwork: string }

export function openTeamDb(file: string): TeamDb {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  const db = new Database(file, { create: true })
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000')
  db.exec(
    'CREATE TABLE IF NOT EXISTS team (id INTEGER PRIMARY KEY, name TEXT NOT NULL, display_name TEXT NOT NULL, num TEXT NOT NULL, types TEXT NOT NULL, artwork TEXT NOT NULL, added_at INTEGER NOT NULL)',
  )
  const listQ = db.query<Row, []>('SELECT id, name, display_name, num, types, artwork FROM team ORDER BY added_at, rowid')
  const hasQ = db.query<{ one: number }, [number]>('SELECT 1 AS one FROM team WHERE id = ?')
  const countQ = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM team')
  const insertQ = db.query('INSERT INTO team (id, name, display_name, num, types, artwork, added_at) VALUES (?, ?, ?, ?, ?, ?, MAX(?, (SELECT COALESCE(MAX(added_at), 0) + 1 FROM team)))')
  const deleteQ = db.query('DELETE FROM team WHERE id = ?')
  // added_at is a clock that never repeats (MAX(now, last + 1)): rowid IS the Pokémon id, so it cannot break same-ms ties.
  // count check + insert under ONE write lock (.immediate): two workers adding at five members cannot both succeed.
  const addTx = db.transaction((m: TeamMember): AddResult => {
    if (hasQ.get(m.id)) return 'present'
    if ((countQ.get()?.n ?? 0) >= MAX_TEAM) return 'full'
    insertQ.run(m.id, m.name, m.displayName, m.num, JSON.stringify(m.types), m.artwork, Date.now())
    return 'added'
  })
  return {
    list: () => listQ.all().map((r) => ({ id: r.id, name: r.name, displayName: r.display_name, types: JSON.parse(r.types) as string[], artwork: r.artwork, num: r.num })),
    add: (m) => addTx.immediate(m),
    remove: (id) => deleteQ.run(id).changes > 0,
    close: () => db.close(),
  }
}

let shared: TeamDb | null = null
export const teamDbPath = (): string => process.env.POKEDEX_TEAM_DB || join(process.cwd(), 'data/team.sqlite')
/** Opened lazily on first use: `brust build` imports routes.tsx, and building must not create the file. */
export function teamDb(): TeamDb {
  return (shared ??= openTeamDb(teamDbPath()))
}
