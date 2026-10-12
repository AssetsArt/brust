import { brust } from '@brust/core/elysia'
import { cache } from '@brust/core/server'
import { Elysia, t } from 'elysia'
import { stubs } from './lib/do'

const Args = t.Object({ args: t.Object({ tags: t.Optional(t.Array(t.String())), path: t.Optional(t.String()) }), fanout: t.Optional(t.Boolean()) })

export default new Elysia({ adapter: brust() })
  .post('/bump', { body: t.Object({ tag: t.String({ minLength: 1 }) }) }, ({ body }) => cache.invalidate({ tags: [body.tag] }))
  // "Another isolate" invalidated: an epoch publish with origin `remote` (and, for the DO store, the shard deletes), no tier-1 primitive here.
  .post('/e2e/remote', { body: Args }, async ({ body }) => {
    const s = await stubs()
    const { seq } = await s.epoch.publish(body.args, 'remote')
    if (body.fanout) await Promise.all(Array.from({ length: 16 }, (_, i) => s.shard(i).invalidate(body.args, seq)))
    return { seq }
  })
  .post('/e2e/regen', async () => (await stubs()).epoch.__regen())
  .get('/e2e/state', async () => (await stubs()).epoch.__state())
