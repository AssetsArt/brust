import { brust } from '@brust/core/elysia'
import { cache } from '@brust/core/server'
import { Elysia, t } from 'elysia'
import { L2 } from './lib/l2'

const Args = t.Object({ args: t.Object({ tags: t.Optional(t.Array(t.String())), path: t.Optional(t.String()) }) })

export default new Elysia({ adapter: brust() })
  .post('/bump', { body: t.Object({ tag: t.String({ minLength: 1 }) }) }, ({ body }) => cache.invalidate({ tags: [body.tag] }))
  // "Another isolate" invalidated: the shared store drops the bodies and the event is published,
  // without this isolate's tier-1 primitive.
  .post('/e2e/remote', { body: Args }, async ({ body }) => {
    await L2.store.invalidate(body.args)
    return { seq: await L2.broadcast!.publish(body.args, 'remote') }
  })
  // The event arrives but the store still holds the old body (KV lag): the floor must reject it.
  .post('/e2e/remote-publish-only', { body: Args }, async ({ body }) => ({ seq: await L2.broadcast!.publish(body.args, 'remote') }))
  .post('/e2e/delay-next-invalidate', () => {
    L2.__test.delayNextInvalidate(1000)
    return {}
  })
  .post('/e2e/hang-next-get', () => {
    L2.__test.hangNextGet(3000)
    return {}
  })
  .get('/e2e/state', async () => {
    const s = await L2.broadcast!.since!(0)
    return { publishCount: L2.__test.publishCount(), gen: s.gen, seq: s.seq, size: L2.__test.size() }
  })
