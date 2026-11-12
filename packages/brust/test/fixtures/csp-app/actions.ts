import { brust } from '@brust/core/elysia'
import { Elysia, t } from 'elysia'

const app = new Elysia({ adapter: brust() }).post('/echo', { body: t.Object({ msg: t.String() }) }, ({ body }) => ({ echo: body.msg }))
export default app
export type App = typeof app
