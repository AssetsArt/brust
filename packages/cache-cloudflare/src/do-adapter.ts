// The Durable Object adapter: a pull BROADCAST (one `epoch:<ns>` instance) and, with `store: true`, an exact-guarded body store over 16 shards.
// No class import here (it needs `cloudflare:workers` at load): `do.ts` re-exports BrustCacheDO beside this.
import type { CacheAdapter, CacheAdapterFactory, CacheBroadcast, CacheStore, EpochSince, GetResult, InvalidateArgs, SetMeta, StoredPage } from '@brust/core/cache-adapter'
import { combine } from './combine'
import { binding, type GetEnv, workersEnv } from './env'
import { decodeEntry, encodeEntry } from './frame'
import type { FloorsPayload, PageMeta } from './do-class'
import { type DoOptions, fromTable, parseDo } from './options'

export const SHARDS = 16
/** A DO SQLite row is capped at 2 MB; the frame (headers + meta) shares it. */
export const MAX_DO_BODY_BYTES = 1_900_000

/** The RPC surface of a BrustCacheDO stub (types only: do-class.ts is not imported at runtime). */
export interface EpochStub {
  head(): Promise<{ gen: string; seq: number }>
  since(seq: number): Promise<EpochSince>
  publish(args: InvalidateArgs, origin: string): Promise<{ gen: string; seq: number }>
  floors(): Promise<FloorsPayload>
}
export interface ShardStub {
  get(key: string): Promise<Uint8Array | null>
  set(key: string, frame: Uint8Array, meta: PageMeta, stamp: number | null): Promise<boolean>
  invalidate(args: InvalidateArgs, seq: number): Promise<number>
}
interface Namespace { getByName(name: string): unknown }

export interface DoDeps { getEnv?: GetEnv; now?: () => number; retryMs?: number }
export interface DoAdapter extends CacheAdapter {
  broadcast: CacheBroadcast & { since(seq: number): Promise<EpochSince> }
  /** The persisted floors + seq + gen of the epoch instance (combine seeds from it). */
  floors(): Promise<FloorsPayload>
  /** The lane-A composer hook: `[cache] adapter = "cloudflare-kv"` + `broadcast = "cloudflare-do"` is exactly `combine`. */
  composeWith(store: CacheAdapter): CacheAdapter
}

export function shardIndex(key: string): number {
  const n = Number.parseInt(key.at(-1) ?? '', 16)
  if (!Number.isNaN(n)) return n
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0
  return h % SHARDS
}

export function doAdapter(options: DoOptions = {}, deps: DoDeps = {}): DoAdapter {
  const { binding: name, store: withStore } = parseDo(options)
  const getEnv = deps.getEnv ?? workersEnv
  const now = deps.now ?? Date.now
  const retryMs = deps.retryMs ?? 250
  let namespace = 'brust'
  let lastSeq: number | null = null
  const seen = (s: number) => {
    lastSeq = Math.max(lastSeq ?? 0, s)
  }
  const ns = async () => binding<Namespace>(await getEnv(), name, 'Durable Object')
  const epoch = async () => (await ns()).getByName(`epoch:${namespace}`) as EpochStub
  const shard = async (i: number) => (await ns()).getByName(`store:${namespace}:${i}`) as ShardStub

  // ONE epoch publish per `args` object, whichever of store.invalidate / broadcast.publish lane A calls first (R8).
  const memo = new WeakMap<object, Promise<{ seq: number; fanout: Error | null }>>()
  const publishOnce = (args: InvalidateArgs, origin: string) => {
    let p = memo.get(args)
    if (!p) {
      p = (async () => {
        const ep = await epoch()
        let res: { gen: string; seq: number }
        try {
          res = await ep.publish(args, origin)
        } catch {
          await new Promise((r) => setTimeout(r, retryMs))
          res = await ep.publish(args, origin)
        }
        seen(res.seq)
        let fanout: Error | null = null
        if (withStore) {
          const out = await Promise.allSettled(Array.from({ length: SHARDS }, async (_, i) => (await shard(i)).invalidate(args, res.seq)))
          const bad = out.filter((o) => o.status === 'rejected').length
          if (bad > 0) fanout = new Error(`cloudflare-do: ${bad}/${SHARDS} shard invalidations failed`)
        }
        return { seq: res.seq, fanout }
      })()
      memo.set(args, p)
    }
    return p
  }

  const broadcast: DoAdapter['broadcast'] = {
    async publish(args, origin) {
      return (await publishOnce(args, origin)).seq
    },
    async since(seq) {
      const r = await (await epoch()).since(seq)
      seen(r.seq)
      return r
    },
  }

  let store: CacheStore | undefined
  if (withStore) {
    const ensureSeq = async () => {
      if (lastSeq === null) seen((await (await epoch()).head()).seq)
    }
    store = {
      maxBodyBytes: MAX_DO_BODY_BYTES,
      async get(key): Promise<GetResult> {
        await ensureSeq()
        const stamp = lastSeq
        const raw = await (await shard(shardIndex(key))).get(key)
        const e = raw ? decodeEntry(raw) : null
        if (!e) return { page: null, stamp, entryStamp: null, storedAt: null }
        return { page: e.page, stamp, entryStamp: e.meta.entryStamp, storedAt: e.meta.storedAt }
      },
      async set(key: string, page: StoredPage, meta: SetMeta) {
        if (page.body.length > MAX_DO_BODY_BYTES) return false
        const at = now()
        const expiresAt = at + meta.ttlMs
        const frame = encodeEntry(page, { tags: meta.tags, method: meta.method, path: meta.path, entryStamp: meta.stamp, storedAt: at, expiresAt })
        return (await shard(shardIndex(key))).set(key, frame, { tags: meta.tags, method: meta.method, path: meta.path, expiresAt }, meta.stamp)
      },
      async invalidate(args: InvalidateArgs) {
        // lane A calls store.invalidate and broadcast.publish in the same tick: let publish register its origin first.
        await Promise.resolve()
        const r = await (memo.get(args) ?? publishOnce(args, 'store'))
        if (r.fanout) throw r.fanout
      },
    }
  }

  const adapter: DoAdapter = {
    name: 'cloudflare-do',
    runtimes: ['workers'],
    ...(store ? { store } : {}),
    broadcast,
    async init(ctx) {
      namespace = ctx.namespace
    },
    async floors() {
      const f = await (await epoch()).floors()
      seen(f.seq)
      return f
    },
    composeWith(base) {
      return combine(base, adapter)
    },
  }
  return adapter
}

/** The `[cache.cloudflare]` table (`do_binding`, `do_store`) -> the adapter (the default export of `/do`). */
export const doFactory: CacheAdapterFactory = (table) => doAdapter(fromTable(table, 'cloudflare-do').do)
