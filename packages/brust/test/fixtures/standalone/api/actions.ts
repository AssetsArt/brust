import { brust } from '@brust/core/elysia'
import { Elysia, t } from 'elysia'

// The shared source of the typed client: `import type { App } from './actions'`.
const app = new Elysia({ adapter: brust() })
  .get('/hello', () => ({ hello: 'standalone' }))
  .post('/team', { body: t.Object({ name: t.String() }) }, ({ body, set }) => {
    // A cross-site cookie needs SameSite=None; Secure (browsers treat http://127.0.0.1 and localhost as secure contexts).
    set.headers['set-cookie'] = `team=${encodeURIComponent(body.name)}; Path=/; SameSite=None; Secure; HttpOnly`
    return { saved: body.name }
  })
  .get('/team', ({ cookie }) => ({ team: cookie.team?.value ?? null }))

export type App = typeof app
export default app
