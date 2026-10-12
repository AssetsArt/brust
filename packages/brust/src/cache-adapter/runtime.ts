// The cache adapter at run time, on both hosts: the per-process (native) / per-isolate (Workers)
// adapter, what `cache.invalidate` does after the tier-1 primitive, and the native worker-0
// subscriber that replays other processes' invalidations. No `bun` import (CF-bundle safe).
//
// L3: a replayed event is applied through the host's REPLAY primitive (napi `cacheReplay`, wasm
// `core.l2_replay`), never through `cache.invalidate`, so it is never published again.
import type { CacheAdapter, InvalidateArgs, InvalidationEvent } from './types'

export interface CacheRuntime {
  adapter: CacheAdapter
  /** This process / isolate: events it published carry it and are not replayed here. */
  origin: string
  /** Keeps a background promise alive (Workers: `waitUntil`; native: a swallowed floating promise). */
  defer: (p: Promise<unknown>) => void
  /** Bumps a `stats.l2` counter (napi `cacheL2Count` / wasm `rt.l2Count`). */
  count: (name: string) => void
  /** Resolves once the adapter's `init` ran (Workers defer it to the first use). */
  ready?: () => Promise<void>
  /**
   * The host's replay primitive (napi `cacheReplay` / wasm `rt.replay` → `Core::l2_replay`): tier 1
   * again plus the floor at `seq` (`null` = tier 1 only). Never publishes.
   */
  replay?: (args: InvalidateArgs, seq: number | null) => void
}

let current: CacheRuntime | null = null

/** Installed at worker boot (native) / `install` (Workers); `null` uninstalls (tests). */
export function setCacheRuntime(r: CacheRuntime | null): void {
  current = r
}

export function cacheRuntime(): CacheRuntime | null {
  return current
}

const describe = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * After `cache.invalidate`'s tier-1 primitive: the shared-side delete, THEN the publish (ruling
 * L7a: other instances replay only once the store no longer holds the bodies), deferred off the
 * request path; THEN this instance replays its own invalidation once (review F1): a request in the
 * window before the delete landed could re-fill tier 1 from the old L2 body, and its own echo is
 * skipped, so the replay re-clears tier 1 and raises the floor to the publish seq (a re-filled
 * body is older). Never throws, never leaves a rejected promise (a worker-side unhandled rejection
 * is fatal on native). Option values are never logged.
 */
export function afterInvalidate(args: InvalidateArgs): void {
  const r = current
  if (!r || (!r.adapter.store && !r.adapter.broadcast)) return
  const { adapter, origin, count } = r
  const task = (async () => {
    await r.ready?.()
    if (adapter.store) {
      try {
        await adapter.store.invalidate(args)
      } catch (e) {
        count('errors')
        console.error(`[brust] cache adapter "${adapter.name}": store.invalidate failed: ${describe(e)}`)
      }
    }
    let seq: number | null = null
    if (adapter.broadcast) {
      try {
        seq = await adapter.broadcast.publish(args, origin)
        count('published')
      } catch (e) {
        count('publish_errors')
        console.error(`[brust] cache adapter "${adapter.name}": publish failed: ${describe(e)}`)
      }
    }
    try {
      r.replay?.(args, typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0 ? seq : null)
    } catch (e) {
      count('errors')
      console.error(`[brust] cache adapter "${adapter.name}": own replay failed: ${describe(e)}`)
    }
  })()
  r.defer(task.catch(() => {}))
}

export interface SubscriberDeps {
  /** napi `cacheReplay(args, seq)`: tier 1 + the floor, never re-published. */
  replay: (args: InvalidateArgs, seq: number) => void
  /** napi `cacheClear()`: both tier-1 caches dropped (a gap). */
  clear: () => void
  count: (name: string) => void
}

/**
 * Native worker 0's push subscriber (R10): first event adopts its seq; `seq <= last` is ignored;
 * `seq > last + 1` clears tier 1 then adopts; `onGap` clears and forgets. Own events advance the
 * seq but are not replayed (tier 1 is already invalidated). Resolves to the unsubscribe.
 */
export async function startSubscriber(adapter: CacheAdapter, origin: string, deps: SubscriberDeps): Promise<(() => Promise<void>) | null> {
  const sub = adapter.broadcast?.subscribe
  if (!sub) return null
  let last: number | null = null
  const on = (e: InvalidationEvent) => {
    try {
      if (last !== null && e.seq <= last) return
      if (last !== null && e.seq > last + 1) deps.clear()
      last = e.seq
      if (e.origin === origin) {
        deps.count('skipped_own')
        return
      }
      deps.replay(e.args, e.seq)
      deps.count('received')
    } catch (err) {
      deps.count('errors')
      console.error(`[brust] cache adapter "${adapter.name}": replay failed: ${describe(err)}`)
    }
  }
  const onGap = () => {
    try {
      deps.clear()
    } catch (err) {
      console.error(`[brust] cache adapter "${adapter.name}": clear failed: ${describe(err)}`)
    }
    last = null
  }
  return sub.call(adapter.broadcast, on, onGap)
}
