import type { CacheAdapter, CacheAdapterInit, GetResult, InvalidateArgs, InvalidationEvent, SetMeta, StoredPage } from '@brust/core/cache-adapter'
import { Link } from './conn'
import { decodeFrame, encodeFrame } from './frame'
import { type Keys, keys as makeKeys } from './keys'
import { evalsha, SET_SCRIPT } from './lua'
import { Pairing } from './pairing'
import { parseOptions, type ResolvedOptions } from './options'
import { type SubscriberState, startSubscriber } from './subscriber'

const STAGE_TTL_MS = 30_000
const MAX_ORPHAN_BATCHES = 64

export interface RedisAdapterTest {
  /** Close the subscriber socket as a network loss would. */
  dropSubscriber(): void
  /** Close the command socket as a network loss would (the loop reconnects). */
  dropCommands(): void
  state(): { connected: boolean; subscribed: boolean; last: number | null; reconnects: number }
  /** The command client (raw access for tests). */
  client(): import('bun').RedisClient
  keys(): Keys
}

export type RedisAdapter = CacheAdapter & { __test: RedisAdapterTest }

export function createAdapter(name: 'redis' | 'dragonfly', raw: Record<string, unknown>): RedisAdapter {
  const o: ResolvedOptions = parseOptions(raw)
  let ks: Keys | null = null
  let cmd: Link | null = null
  const k = (): Keys => ks ?? fail()
  const link = (): Link => cmd ?? fail()
  const fail = (): never => {
    throw new Error('cache-redis: used before init')
  }
  const sub: SubscriberState = { link: null, subscribed: false, last: null }
  const pairing = new Pairing(() => link().c, k, o.markerTtlMs, () => k().channel)
  // N2: page batches whose UNLINK failed (the link dropped between the script and the delete); retried once on reconnect.
  const orphaned: string[][] = []

  const store = {
    maxBodyBytes: o.maxBodyBytes,
    async get(key: string): Promise<GetResult> {
      const c = link().c
      const [buf, seq] = await Promise.all([c.getBuffer(k().page(key)), c.get(k().seq)])
      const stamp = Number(seq ?? 0)
      if (buf === null) return { page: null, stamp, entryStamp: null, storedAt: null }
      const f = decodeFrame(buf)
      if (f === null) throw new Error('cache-redis: stored page has an unknown frame version')
      return { page: f.page, stamp, entryStamp: f.entryStamp, storedAt: f.storedAt }
    },
    async set(key: string, page: StoredPage, meta: SetMeta): Promise<boolean> {
      if (page.body.length > o.maxBodyBytes) return false
      const c = link().c
      const K = k()
      const method = meta.method.toUpperCase()
      const tags = [...new Set(meta.tags)]
      const stage = K.stage(crypto.randomUUID())
      const idx = [...tags.map((t) => K.tag(t)), K.path(method, meta.path)]
      const marks = [...tags.map((t) => K.markTag(t)), K.markPath(method, meta.path)]
      const frame = encodeFrame(page, { entryStamp: meta.stamp, storedAt: Date.now(), tags, method, path: meta.path })
      // Both commands go out on the one auto-pipelined connection: one round trip.
      const staged = c.set(stage, frame, 'PX', STAGE_TTL_MS)
      const ran = evalsha(c, SET_SCRIPT, [stage, K.page(key), ...idx, ...marks], [meta.stamp === null ? '' : meta.stamp, Math.max(1, Math.ceil(meta.ttlMs)), idx.length])
      const [a, b] = await Promise.allSettled([staged, ran])
      if (a.status === 'rejected') throw a.reason
      if (b.status === 'rejected') throw b.reason
      if (b.value === -1) {
        console.warn('[brust] cache-redis: staging key vanished before the guarded write')
        return false
      }
      return b.value === 1
    },
    async invalidate(args: InvalidateArgs): Promise<void> {
      const { members } = await pairing.run(args, 'invalidate')
      if (!members.length) return
      const c = link().c
      // UNLINK frees off the main thread (Dragonfly too); batched so one call never carries every key.
      const batches: string[][] = []
      for (let i = 0; i < members.length; i += o.unlinkBatch) batches.push(members.slice(i, i + o.unlinkBatch))
      const done = await Promise.allSettled(batches.map((b) => c.unlink(...b)))
      // A failed batch is kept (at most MAX_ORPHAN_BATCHES, then the page TTL is the bound) and retried once on reconnect.
      const failed = done.flatMap((d, i) => (d.status === 'rejected' ? [i] : []))
      for (const i of failed) if (orphaned.length < MAX_ORPHAN_BATCHES) orphaned.push(batches[i]!)
      const first = done.find((d): d is PromiseRejectedResult => d.status === 'rejected')
      if (first) throw first.reason
    },
  }

  const broadcast = {
    async publish(args: InvalidateArgs, origin: string): Promise<number> {
      // The event is published by the script itself (N1): a failure here means no seq was taken and no event went out.
      const { seq } = await pairing.run(args, 'publish', origin)
      return seq
    },
    async subscribe(on: (e: InvalidationEvent) => void, onGap: () => void): Promise<() => Promise<void>> {
      return startSubscriber(o, k(), async () => Number((await link().c.get(k().seq)) ?? 0), sub, on, onGap)
    },
  }

  const adapter: RedisAdapter = {
    name,
    runtimes: ['bun'],
    store,
    broadcast,
    async init(ctx: CacheAdapterInit) {
      ks = makeKeys(ctx.namespace)
      cmd = new Link(o, 'commands', async (cl) => {
        for (const b of orphaned.splice(0)) await cl.unlink(...b).catch(() => 0) // once: a second failure leaves it to the TTL
      })
      await cmd.start()
    },
    async close() {
      sub.link?.close()
      cmd?.close()
    },
    __test: {
      dropSubscriber: () => sub.link?.drop(),
      dropCommands: () => cmd?.drop(),
      state: () => ({ connected: !!cmd?.connected, subscribed: sub.subscribed, last: sub.last, reconnects: (cmd?.reconnects ?? 0) + (sub.link?.reconnects ?? 0) }),
      client: () => link().c,
      keys: () => k(),
    },
  }
  return adapter
}

export type { InvalidationEvent }
