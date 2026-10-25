// The cache adapter contract (cache adapter design §3.1): a shared second
// tier behind brust's in-process cache. An adapter has two optional capabilities — a `store` of
// rendered pages and a `broadcast` of invalidations (push `subscribe` or pull `since`) — so a store
// without a channel (KV) can be composed with another adapter's broadcast (DO).
//
// One sequence space per adapter: every `stamp`, `entryStamp` and event `seq` is a number in its
// broadcast's sequence (a store without a broadcast reports `null` stamps and its writes are unguarded).
import type { InvalidateArgs } from '../native'

export type { InvalidateArgs }

/** A rendered page: the identity body and its validated headers, in order (repeats kept). */
export interface StoredPage {
  status: number
  headers: [string, string][]
  body: Uint8Array
}

export interface SetMeta {
  ttlMs: number
  tags: string[]
  method: string
  path: string
  /** The `stamp` the lookup returned (read before the render); `null` = unguarded write. */
  stamp: number | null
}

export interface GetResult {
  page: StoredPage | null
  /** The broadcast seq NOW: the write-guard base of the set that may follow this miss. */
  stamp: number | null
  /** The stamp the entry was written under (`SetMeta.stamp`); the invalidation floor compares it. */
  entryStamp: number | null
  /** When the entry was written (ms since the epoch); `null` = unknown (full ttl). */
  storedAt: number | null
}

export interface CacheStore {
  get(key: string): Promise<GetResult>
  /**
   * `false` = refused: the stamp is older than an invalidation of one of `meta.tags` or of
   * `meta.method meta.path` (a store with atomic writes MUST refuse it), or the body is over `maxBodyBytes`.
   */
  set(key: string, page: StoredPage, meta: SetMeta): Promise<boolean>
  /**
   * Shared-side delete by tags/path (`key` is a no-op: the store holds pages only). Records the
   * invalidation marker BEFORE deleting, so a concurrent stale `set` is refused even before the
   * publish (ruling L7b).
   */
  invalidate(args: InvalidateArgs): Promise<void>
  readonly maxBodyBytes: number
}

export interface InvalidationEvent {
  seq: number
  origin: string
  args: InvalidateArgs
}

export interface EpochSince {
  /** The broadcast's generation: a change means its history is gone (every reader clears). */
  gen: string
  /** The latest seq. */
  seq: number
  /** The reader is further behind than the retained history: it must clear. */
  behind: boolean
  /** Every retained event with a seq above the one asked for, in order. */
  events: InvalidationEvent[]
}

export interface CacheBroadcast {
  /** Append an invalidation; resolves to the seq it was assigned. */
  publish(args: InvalidateArgs, origin: string): Promise<number>
  /** Push: events in order; `onGap` when delivery may have lost some. Resolves to an unsubscribe. */
  subscribe?(on: (e: InvalidationEvent) => void, onGap: () => void): Promise<() => Promise<void>>
  /** Pull: the events after `seq` (Workers: the only mode, no connection outlives a request). */
  since?(seq: number): Promise<EpochSince>
}

export interface CacheAdapterInit {
  namespace: string
  buildId: string
  runtime: 'bun' | 'workers'
  workerId: number
}

export interface CacheAdapter {
  readonly name: string
  readonly runtimes: ReadonlyArray<'bun' | 'workers'>
  store?: CacheStore
  broadcast?: CacheBroadcast
  init?(ctx: CacheAdapterInit): Promise<void>
  close?(): Promise<void>
}

export type CacheAdapterFactory = (options: Record<string, unknown>) => CacheAdapter
