// website/actions.ts — the docs site's actions (one Elysia 2 app behind the Rust server; brust.toml [actions]).
// The demo team lives in a cookie, not in server memory: every Bun worker has its own memory, so a module-level
// array would answer differently per worker, and a cookie also keeps each reader's team their own.
import { brust } from '@brust/core/elysia'
import { Elysia, problem, t } from 'elysia'
import { MAX_TEAM, member, teamCookie, teamFromCookie } from './components/demos/team-cookie'
import type { TeamMember } from './components/demos/team-store'
import { byId } from './lib/pokemon'

function save(set: { headers: Record<string, unknown> }, team: TeamMember[]) {
  set.headers['set-cookie'] = teamCookie(team)
  return { team, max: MAX_TEAM }
}

const app = new Elysia({ adapter: brust() })
  .get('/team', ({ request }) => ({ team: teamFromCookie(request.headers.get('cookie')), max: MAX_TEAM }))
  .post('/team', { body: t.Object({ id: t.Integer({ minimum: 1 }) }) }, ({ body, request, set }) => {
    if (!byId(body.id)) return problem(404, { title: 'UnknownPokemon', detail: `no Pokémon #${body.id} in this demo` })
    const team = teamFromCookie(request.headers.get('cookie'))
    if (team.some((m) => m.id === body.id)) return save(set, team)
    if (team.length >= MAX_TEAM) return problem(409, { title: 'TeamFull', detail: `the team already has ${MAX_TEAM} members`, max: MAX_TEAM })
    return save(set, [...team, member(body.id)])
  })
  .delete('/team/:id', { params: t.Object({ id: t.Integer({ minimum: 1 }) }) }, ({ params, request, set }) =>
    save(
      set,
      teamFromCookie(request.headers.get('cookie')).filter((m) => m.id !== params.id),
    ),
  )

export default app
export type App = typeof app
