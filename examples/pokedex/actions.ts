// examples/pokedex/actions.ts — the team RPC surface (M3-F E7). One Elysia 2 app behind the Rust server
// (brust.toml [actions]); never imported by browser code except as `import type { App }`.
import { cache, type InvalidateArgs } from '@brust/core'
import { brust } from '@brust/core/elysia'
import { Elysia, problem, t } from 'elysia'
import { pokemonById } from './lib/pokeapi'
import { MAX_TEAM } from './lib/team'
import { type TeamDb, teamDb } from './lib/team-db'

export interface TeamDeps {
  db: () => TeamDb
  invalidate: (a: InvalidateArgs) => unknown
}

export function teamApp({ db, invalidate }: TeamDeps = { db: teamDb, invalidate: cache.invalidate }) {
  const reply = async () => ({ team: await db().list(), max: MAX_TEAM })
  // R5: cached pages that render the team carry the tag `team`; drop them after a real change.
  const changed = () => invalidate({ tags: ['team'] })
  return new Elysia({ adapter: brust() })
    .get('/team', () => reply())
    .post('/team', { body: t.Object({ id: t.Integer({ minimum: 1 }) }) }, async ({ body }) => {
      const p = pokemonById(body.id)
      if (!p) return problem(404, { title: 'UnknownPokemon', detail: `no Pokémon #${body.id}` })
      const r = await db().add(p)
      if (r === 'full') return problem(409, { title: 'TeamFull', detail: `the team already has ${MAX_TEAM} members`, max: MAX_TEAM })
      if (r === 'added') changed()
      return reply()
    })
    .delete('/team/:id', { params: t.Object({ id: t.Integer({ minimum: 1 }) }) }, async ({ params }) => {
      if (await db().remove(params.id)) changed()
      return reply()
    })
}

const app = teamApp()
export default app
export type App = typeof app
