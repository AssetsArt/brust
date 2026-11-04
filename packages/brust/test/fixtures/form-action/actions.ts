import { brust } from '@brust/core/elysia'
import { Elysia, problem, t } from 'elysia'

const team: number[] = []
const MAX = 6

const app = new Elysia({ adapter: brust() })
  .get('/team', () => ({ team, max: MAX }))
  .post('/team', { body: t.Object({ id: t.Integer({ minimum: 1 }) }) }, ({ body }) => {
    if (team.length >= MAX) return problem(409, { title: 'TeamFull', max: MAX })
    if (!team.includes(body.id)) team.push(body.id)
    return { team, max: MAX }
  })

export default app
export type App = typeof app
