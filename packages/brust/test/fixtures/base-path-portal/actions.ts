import { Elysia, t } from 'elysia'
import { brust } from '@brust/core/elysia'

export default new Elysia({ adapter: brust() })
  .get('/who', () => ({ app: 'portal' }))
  .post('/echo', { body: t.Object({ msg: t.String() }) }, ({ body }) => ({ app: 'portal', body }))
