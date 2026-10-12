import { brust } from '@brust/core/elysia'
import { cache } from '@brust/core/server'
import { Elysia, t } from 'elysia'

export default new Elysia({ adapter: brust() }).post('/bump', { body: t.Object({ tag: t.String({ minLength: 1 }) }) }, ({ body }) =>
  cache.invalidate({ tags: [body.tag] }),
)
