import { brust } from '@brust/core/elysia'
import { Elysia, t } from 'elysia'

const app = new Elysia({ adapter: brust() })
  .post('/echo', { body: t.Object({ msg: t.String() }) }, ({ body }) => ({ echo: body.msg }))
  .post('/form', () => new Response('<!doctype html><html><head><title>posted</title></head><body><h1>posted</h1></body></html>', { headers: { 'content-type': 'text/html' } }))
  .ws('/live', {
    message(ws, m) {
      ws.send(`pong:${m}`)
    },
  })
export default app
export type App = typeof app
