// Treaty actions — the team-store RPC surface. Wired into brust.run({ actions }).
//
// Client calls (from the islands):
//   api.team.get()                 → GET    /_brust/action/team
//   api.team.post({ … })           → POST   /_brust/action/team
//   api.team({ id }).delete()      → DELETE /_brust/action/team/{id}

import { z } from 'zod'
import { defineActions } from '../../runtime/index.ts'
import { MAX_TEAM, teamStore } from './lib/team-store'

const TeamMemberInput = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  displayName: z.string().min(1),
  num: z.string(),
  types: z.array(z.string()).max(2),
  artwork: z.string(),
})

export const actions = defineActions()
  .get('/team', () => ({ team: teamStore.list(), max: MAX_TEAM }))
  .post(
    '/team',
    ({ body }) => {
      const ok = teamStore.add(body)
      // GAP S7: a domain error (team full) cannot throw a typed non-2xx across
      // the treaty boundary, so it rides back inside the success payload as a
      // `full` flag. The client therefore checks two places (transport `error`
      // AND `data.full`). See ./FRAMEWORK-GAPS.md S7.
      return { team: teamStore.list(), max: MAX_TEAM, full: !ok }
    },
    { body: TeamMemberInput },
  )
  .delete('/team/{id}', ({ params }) => {
    teamStore.remove(Number(params.id))
    return { team: teamStore.list(), max: MAX_TEAM }
  })

export type Actions = typeof actions
