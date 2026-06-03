// Treaty actions — the team-store RPC surface. Wired into brust.run({ actions }).
//
// Client calls (from the islands):
//   api.team.get()                 → GET    /_brust/action/team
//   api.team.post({ … })           → POST   /_brust/action/team
//   api.team({ id }).delete()      → DELETE /_brust/action/team/{id}

import { z } from 'zod'
import { defineActions, ActionError } from 'brustjs'
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
      if (!teamStore.add(body)) {
        throw new ActionError(409, 'TEAM_FULL', { data: { max: MAX_TEAM } })
      }
      return { team: teamStore.list(), max: MAX_TEAM }
    },
    { body: TeamMemberInput, errors: { TEAM_FULL: z.object({ max: z.number() }) } },
  )
  .delete('/team/{id}', ({ params }) => {
    teamStore.remove(Number(params.id))
    return { team: teamStore.list(), max: MAX_TEAM }
  })

export type Actions = typeof actions
