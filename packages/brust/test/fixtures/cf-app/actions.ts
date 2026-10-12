import { brust } from '@brust/core/elysia'
import { cache } from '@brust/core'
import { Elysia } from 'elysia'
import { dbName } from './lib/db'

export default new Elysia({ adapter: brust() })
  .get('/hello', () => ({ hi: dbName }))
  .get('/invalidate', () => cache.invalidate({ tags: ['x'] }))
