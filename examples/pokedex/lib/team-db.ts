// examples/pokedex/lib/team-db.ts — the TeamDb interface (async: D1 has no sync API) and the native default.
// `brust build --target cloudflare` swaps this whole module for lib/team-db.d1.ts via brust.toml [cloudflare.alias],
// so app imports (`./lib/team-db`) never change. Server-only (brust.toml [build] server_only = lib/team-db).
import type { TeamMember } from './types'

export type AddResult = 'added' | 'present' | 'full'
export interface TeamDb {
  list(): Promise<TeamMember[]>
  add(m: TeamMember): Promise<AddResult>
  remove(id: number): Promise<boolean>
}

export { openTeamDb, type SqliteTeamDb, teamDb, teamDbPath } from './team-db.sqlite'
