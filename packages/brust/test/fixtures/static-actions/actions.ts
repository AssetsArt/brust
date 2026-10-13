import { brust } from '@brust/core/elysia'
import { Elysia, t } from 'elysia'

export default new Elysia({ adapter: brust() })
  .get('/hello', () => ({ hello: 'pages' }))
  .post('/echo', { body: t.Object({ msg: t.String() }) }, ({ body }) => ({ echo: body.msg }))
