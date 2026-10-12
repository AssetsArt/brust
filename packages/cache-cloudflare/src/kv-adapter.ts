// Cloudflare KV as a cache STORE (no broadcast). Body and meta share one KV value (R4); KV alone never invalidates (R5): a stale body
// lives until its ttl, so pair it with `broadcast = "cloudflare-do"` (combine) for correct invalidation.
import type { CacheAdapter, CacheStore, GetResult, InvalidateArgs, SetMeta, StoredPage } from '@brust/core/cache-adapter'
import { binding, type GetEnv, workersEnv } from './env'
import { decodeEntry, encodeEntry, type EntryMeta } from './frame'
import { type KvOptions, parseKv } from './options'

/** KV's 60 s floor on `expirationTtl`, and its 1 write/s/key limit: an identical frame written < 60 s ago is not rewritten. */
const MIN_EXPIRATION_S = 60
const MEMO_CAP = 1024

export interface KvStore extends CacheStore {
  /** `get` plus the entry's stored meta (tags, method, path): combine needs them to judge an entry against its floors. */
  getWithMeta(key: string): Promise<{ result: GetResult; meta: EntryMeta | null }>
}
export interface KvAdapter extends CacheAdapter {
  store: KvStore
}

export interface KvDeps { getEnv?: GetEnv; now?: () => number }

function fingerprint(u8: Uint8Array): string {
  let h = 0x811c9dc5
  for (let i = 0; i < u8.length; i++) h = Math.imul(h ^ u8[i]!, 0x01000193) >>> 0
  return `${u8.length}:${h}`
}

export function kvAdapter(options: KvOptions = {}, deps: KvDeps = {}): KvAdapter {
  const { binding: name, minTtlS } = parseKv(options)
  const getEnv = deps.getEnv ?? workersEnv
  const now = deps.now ?? Date.now
  const memo = new Map<string, { at: number; fp: string }>()
  const kv = async () => binding<KVNamespace>(await getEnv(), name, 'KV')

  const store: KvStore = {
    // The key is a 512-byte limit away from lane A's L2Key; bodies are bounded by the core's max_body_bytes (KV allows 25 MiB).
    maxBodyBytes: 8 * 1024 * 1024,
    async getWithMeta(key) {
      const none = { result: { page: null, stamp: null, entryStamp: null, storedAt: null } as GetResult, meta: null }
      const raw = await (await kv()).get(key, { type: 'arrayBuffer', cacheTtl: 60 })
      if (!raw) return none
      const e = decodeEntry(new Uint8Array(raw))
      if (!e || e.meta.expiresAt <= now()) return none
      return { result: { page: e.page, stamp: null, entryStamp: e.meta.entryStamp, storedAt: e.meta.storedAt }, meta: e.meta }
    },
    async get(key) {
      return (await store.getWithMeta(key)).result
    },
    async set(key: string, page: StoredPage, meta: SetMeta) {
      if (meta.ttlMs < minTtlS * 1000) return false
      if (page.body.length > store.maxBodyBytes) return false
      const at = now()
      const frame = encodeEntry(page, { tags: meta.tags, method: meta.method, path: meta.path, entryStamp: meta.stamp, storedAt: at, expiresAt: at + meta.ttlMs })
      const fp = `${fingerprint(page.body)}:${JSON.stringify([page.status, page.headers, meta.tags, meta.method, meta.path, meta.stamp])}`
      const prev = memo.get(key)
      if (prev && prev.fp === fp && at - prev.at < 60_000) return true
      try {
        await (await kv()).put(key, frame, { expirationTtl: Math.max(MIN_EXPIRATION_S, Math.ceil(meta.ttlMs / 1000)) })
      } catch (e) {
        if (/\b429\b|too many requests|rate limit/i.test(String((e as Error)?.message ?? e))) return false
        throw e
      }
      memo.delete(key)
      memo.set(key, { at, fp })
      if (memo.size > MEMO_CAP) memo.delete(memo.keys().next().value as string)
      return true
    },
    async invalidate(_args: InvalidateArgs) {
      // R5: an L2Key hashes prefix+method+path+query, so a tag or path cannot be enumerated without index writes; KV alone is "stale <= ttl".
    },
  }
  return { name: 'cloudflare-kv', runtimes: ['workers'], store }
}
