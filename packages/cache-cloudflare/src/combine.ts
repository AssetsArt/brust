// combine(kv, do): the KV store + the DO broadcast, with correct invalidation floors kept in JS (R6). The Rust cursor alone is not enough: an isolate that
// first-contacts the DO adopts without replay, so it would serve a KV body invalidated before it started, for up to ttl. Floors are seeded from the DO
// (persisted names -> seq), raised by every replayed event / own publish / local invalidate, and judge each KV hit by its `entryStamp`.
import type { CacheAdapter, CacheStore, GetResult, InvalidateArgs, SetMeta, StoredPage } from '@brust/core/cache-adapter'
import type { DoAdapter } from './do-adapter'
import { Floors } from './floors'
import type { KvAdapter } from './kv-adapter'

export function combine(kvIn: CacheAdapter, d: DoAdapter): CacheAdapter {
  const kv = kvIn as KvAdapter
  if (!kv.store || typeof kv.store.getWithMeta !== 'function')
    throw new TypeError(`cloudflare-do broadcast can only be composed with the "cloudflare-kv" store (got "${kvIn.name}")`)
  const floors = new Floors()
  let gen: string | null = null
  let lastSeq = 0
  let seeded = false
  let seeding: Promise<void> | null = null
  const seed = () =>
    (seeding ??= (async () => {
      try {
        const f = await d.floors()
        floors.seed({ names: f.names, evicted: f.evicted })
        gen = f.gen
        lastSeq = Math.max(lastSeq, f.seq)
        seeded = true
      } finally {
        seeding = null
      }
    })())

  const store: CacheStore = {
    maxBodyBytes: kv.store.maxBodyBytes,
    async get(key): Promise<GetResult> {
      if (!seeded) await seed()
      const stamp = lastSeq
      const { result, meta } = await kv.store.getWithMeta(key)
      if (!result.page || !meta) return { page: null, stamp, entryStamp: null, storedAt: null }
      // A hit written under a stamp below its floor (or one with no stamp at all) is judged invalid.
      if (result.entryStamp === null || result.entryStamp < floors.floorOf(meta.tags, meta.method, meta.path)) return { page: null, stamp, entryStamp: null, storedAt: null }
      return { ...result, stamp }
    },
    async set(key: string, page: StoredPage, meta: SetMeta) {
      if (!seeded) await seed()
      // `stamp: null` = an unguarded write: it is stamped with the seq known now, so floors judge it from here on.
      const stamp = meta.stamp ?? lastSeq
      if (meta.stamp !== null && stamp < floors.floorOf(meta.tags, meta.method, meta.path)) return false
      return kv.store.set(key, page, { ...meta, stamp })
    },
    async invalidate(args: InvalidateArgs) {
      // Hide the pages at once on this isolate; the matching publish returns the real seq (>= lastSeq + 1) and raises it.
      floors.raiseArgs(args, lastSeq + 1)
    },
  }

  return {
    name: 'cloudflare-kv+do',
    runtimes: ['workers'],
    store,
    broadcast: {
      async publish(args, origin) {
        const seq = await d.broadcast.publish(args, origin)
        floors.raiseArgs(args, seq)
        lastSeq = Math.max(lastSeq, seq)
        return seq
      },
      async since(seq) {
        const r = await d.broadcast.since(seq)
        if (!seeded || r.gen !== gen || r.behind) await seed()
        else {
          for (const e of r.events) floors.raiseArgs(e.args, e.seq)
          lastSeq = Math.max(lastSeq, r.seq)
        }
        return r
      },
    },
    async init(ctx) {
      await kv.init?.(ctx)
      await d.init?.(ctx)
    },
    async close() {
      await Promise.allSettled([kv.close?.(), d.close?.()])
    },
  }
}
