import { brust } from '@brust/core/elysia'
import { Elysia, status, t } from 'elysia'

// F471: a session in two cookies. `sid=ok` is the session; `/refresh` renews it and sets BOTH cookies;
// every other route answers a typed 401 without it.
const authed = (cookie: Record<string, { value?: unknown }>) => cookie.sid?.value === 'ok'

const app = new Elysia({ adapter: brust() })
  .get('/me', ({ cookie, request }) =>
    authed(cookie) ? { user: 'ash', org: request.headers.get('x-org') } : status(401, { error: 'unauthorized' as const }),
  )
  .post('/notes', { body: t.Object({ text: t.String() }) }, ({ cookie, body }) =>
    authed(cookie) ? { saved: body.text } : status(401, { error: 'unauthorized' as const }),
  )
  .post('/refresh', ({ set }) => {
    set.headers['set-cookie'] = ['sid=ok; Path=/; HttpOnly', 'csrf=c1; Path=/']
    return { renewed: true }
  })
  .post('/logout', ({ cookie }) => {
    cookie.sid!.set({ value: '', maxAge: 0, path: '/', httpOnly: true })
    cookie.csrf!.set({ value: '', maxAge: 0, path: '/' })
    return status(401, { error: 'unauthorized' as const })
  })

export type App = typeof app
export default app
