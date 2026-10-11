import { Elysia, HTTPError, problem, t } from 'elysia'
import { brust } from '@brust/core/elysia'

export class TeamFull extends HTTPError.id('TEAM_FULL') {
  override readonly status = 409
  constructor(readonly max: number) {
    super('team is full')
  }
  detail() {
    return { max: this.max }
  }
}

const app = new Elysia({ adapter: brust() })
  .get('/', () => 'root')
  .get('/hello', { query: t.Object({ name: t.Optional(t.String()) }) }, ({ query }) => ({
    hi: query.name ?? 'world',
  }))
  .post(
    '/team',
    {
      body: t.Object({ id: t.String(), name: t.String() }),
      cookie: t.Cookie({ sid: t.Optional(t.String()) }),
    },
    ({ body, cookie: { sid } }) =>
      body.id === 'full'
        ? problem(409, { title: 'Team full', max: 6 })
        : ((sid.value = 'abc'), { team: [body], max: 6 }),
  )
  .get('/thrown', () => {
    throw new TeamFull(6)
  })
  .get('/cookies', ({ cookie }) => {
    cookie.a!.value = '1'
    cookie.b!.value = '2'
    return { ok: true }
  })
  .get('/big', () => 'x'.repeat(300 * 1024))
  .get('/url', ({ request }) => ({ path: new URL(request.url).pathname }))

export default app
export type App = typeof app
