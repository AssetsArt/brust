// examples/pokedex/lib/team-db.d1.ts — the TeamDb on Cloudflare D1. `brust.toml` [cloudflare.alias] swaps lib/team-db.ts for
// this file in `brust build --target cloudflare`. The binding is read per call (never at import: the build smoke-imports the
// bundle with an empty env) and nothing is cached across requests.
import { env } from 'cloudflare:workers'
import { MAX_TEAM } from './team'
import type { AddResult, TeamDb } from './team-db'
import type { TeamMember } from './types'

export type { AddResult, TeamDb }

interface Row { id: number; name: string; display_name: string; num: string; types: string; artwork: string }

const LIST = 'SELECT id, name, display_name, num, types, artwork FROM team ORDER BY added_at, rowid'
// ONE statement decides the cap: the count check and the insert cannot be split across awaits on D1 (no transaction handle),
// so the insert is conditional. added_at is a clock that never repeats, as in the sqlite twin.
const INSERT =
  'INSERT INTO team (id, name, display_name, num, types, artwork, added_at) ' +
  'SELECT ?1, ?2, ?3, ?4, ?5, ?6, MAX(?7, (SELECT COALESCE(MAX(added_at), 0) + 1 FROM team)) ' +
  'WHERE (SELECT COUNT(*) FROM team) < ?8 ON CONFLICT(id) DO NOTHING'
const HAS = 'SELECT 1 AS one FROM team WHERE id = ?1'

export function openTeamDb(d1: D1Database): TeamDb {
  return {
    async list() {
      const { results } = await d1.prepare(LIST).all<Row>()
      return results.map((r) => ({ id: r.id, name: r.name, displayName: r.display_name, types: JSON.parse(r.types) as string[], artwork: r.artwork, num: r.num }))
    },
    async add(m: TeamMember): Promise<AddResult> {
      // One batch = one transaction: added (1 row) | present (the id exists, even when full) | full.
      const [ins, has] = await d1.batch([
        d1.prepare(INSERT).bind(m.id, m.name, m.displayName, m.num, JSON.stringify(m.types), m.artwork, Date.now(), MAX_TEAM),
        d1.prepare(HAS).bind(m.id),
      ])
      if (ins!.meta.changes === 1) return 'added'
      return has!.results.length > 0 ? 'present' : 'full'
    },
    async remove(id: number) {
      return (await d1.prepare('DELETE FROM team WHERE id = ?1').bind(id).run()).meta.changes > 0
    },
  }
}

export function teamDb(): TeamDb {
  const d1 = env.TEAM_DB
  if (!d1) throw new Error('TEAM_DB D1 binding missing: add it to wrangler.jsonc (see README)')
  return openTeamDb(d1)
}
