// Dev-facing island ISR cache control. Invalidation crosses to the Rust-side
// store (shared across the worker pool) via NAPI. Call from action/api/loader.
import * as native from './index.js'

export interface InvalidateArgs {
  key?: string
  tags?: string[]
  /** L1 response-cache: evict all entries for this request path (any prefix /
   * query variant). Independent of `tags`. */
  path?: string
  /** HTTP method for the `path` eviction (defaults to GET in Rust). */
  method?: string
}

export const cache = {
  /** Evict across all three caches: islands, L2 page cache, and L1 response
   * cache. `key`/`tags` hit islands + L2; the L1 response cache is reached by
   * `tags` (the ROUTE must declare static `cache.tags` for its L1 entries to
   * carry them) and by `path` (evicts every L1 entry for that request path,
   * any prefix/query variant). All fields optional; `invalidate({})` is a
   * deliberate no-op. The `?.` guards against a stale addon built before a
   * given binding existed (degrades to no-op). */
  invalidate(args: InvalidateArgs): void {
    ;(native as any).islandCacheInvalidate?.(args.key, args.tags)
    // Fan out to the L2 page cache (same key/tag semantics). `?.` keeps a
    // stale addon (built before page-cache bindings existed) a no-op.
    ;(native as any).pageCacheInvalidate?.(args.key, args.tags)
    // Fan out to the L1 response cache by tag (route must declare cache.tags)
    // and/or by path. `?.` keeps a stale addon a no-op.
    ;(native as any).responseCacheInvalidate?.(args.tags, args.path, args.method)
  },
}
