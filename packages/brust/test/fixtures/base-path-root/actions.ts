import { Elysia, t } from 'elysia'
import { brust } from '@brust/core/elysia'

export default new Elysia({ adapter: brust() })
  .get('/who', () => ({ app: 'root' }))
  .post('/echo', { body: t.Object({ msg: t.String() }) }, ({ body }) => ({ app: 'root', body }))
