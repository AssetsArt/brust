// Dev-facing island ISR cache control. Invalidation crosses to the Rust-side
// store (shared across the worker pool) via NAPI. Call from action/api/loader.
import * as native from './index.js'

export interface InvalidateArgs {
  key?: string
  tags?: string[]
}

export const cache = {
  /** Evict by exact key and/or by tag group. Both optional; both may be given.
   * `invalidate({})` forwards `(undefined, undefined)` — a deliberate no-op on
   * the Rust side (neither the key nor the tags branch fires). The `?.` guards
   * against a stale addon built before this export existed (degrades to no-op). */
  invalidate(args: InvalidateArgs): void {
    ;(native as any).islandCacheInvalidate?.(args.key, args.tags)
    // Fan out to the L2 page cache (same key/tag semantics). `?.` keeps a
    // stale addon (built before page-cache bindings existed) a no-op.
    ;(native as any).pageCacheInvalidate?.(args.key, args.tags)
  },
}
