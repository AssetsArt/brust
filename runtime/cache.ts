// Dev-facing island ISR cache control. Invalidation crosses to the Rust-side
// store (shared across the worker pool) via NAPI. Call from action/api/loader.
import * as native from './index.js'

export interface InvalidateArgs {
  key?: string
  tags?: string[]
}

export const cache = {
  /** Evict by exact key and/or by tag group. Both optional; both may be given. */
  invalidate(args: InvalidateArgs): void {
    ;(native as any).islandCacheInvalidate(args.key, args.tags)
  },
}
