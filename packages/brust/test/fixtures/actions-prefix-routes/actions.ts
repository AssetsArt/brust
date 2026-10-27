// The actions app under /auth (F470): Apple's form_post callback is a POST and stays an action; /auth/:provider/start
// has no page route, so a GET there is the action's; GET /google/callback is shadowed by the loader route (boot warning).
import { Elysia } from 'elysia'
import { brust } from '@brust/core/elysia'

export default new Elysia({ adapter: brust() })
  .post('/:provider/callback', ({ params }) => ({ action: 'callback', provider: params.provider }))
  .get('/:provider/start', ({ params }) => ({ action: 'start', provider: params.provider }))
  .get('/google/callback', () => ({ action: 'shadowed' }))
