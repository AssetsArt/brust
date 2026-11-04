// Component-level cache declaration (S4 / §5). The compiler reads `cache(Comp, opts)` statically;
// at runtime it is identity. `cache.invalidate` drops L1 pages and job-cache entries in the
// running server (napi `cacheInvalidate`), then — with a cache adapter — the shared store and the
// broadcast to every other instance (deferred, `cache-adapter/runtime.ts`).
import { afterInvalidate } from './cache-adapter/runtime'
import { cacheComponent } from './cache-core'
import { type InvalidateArgs, type InvalidateResult, cacheInvalidate } from './native'

export type { ComponentCacheOptions } from './cache-core'

const NO_SERVER = 'cache.invalidate needs a running server (call it inside `brust start`)'
/** Same text as brust-core `PREFIX_WITH_KEY` (the Rust hosts refuse it too). */
export const PREFIX_WITH_KEY = 'cache.invalidate: `prefix` narrows page entries; `key` names a job entry — call them separately'

/** F493: `prefix` is a string and never comes with `key`. Throws a TypeError otherwise. */
export function checkInvalidateArgs(args: InvalidateArgs): void {
  const prefix = (args as { prefix?: unknown } | null | undefined)?.prefix
  if (prefix === undefined) return
  if (typeof prefix !== 'string') throw new TypeError(`cache.invalidate: \`prefix\` must be a string (got ${prefix === null ? 'null' : typeof prefix})`)
  if (args.key !== undefined) throw new TypeError(PREFIX_WITH_KEY)
}

function invalidate(args: InvalidateArgs): InvalidateResult {
  checkInvalidateArgs(args)
  let r: InvalidateResult
  try {
    r = cacheInvalidate(args)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // `current()` in brust-napi; a missing addon means no server either.
    if (/startServer has not been called/.test(msg) || /Cannot find (module|package)|Failed to load native binding/i.test(msg))
      throw new Error(`${NO_SERVER}: ${msg}`)
    throw e
  }
  afterInvalidate(args)
  return { l1Removed: r.l1Removed, jobRemoved: r.jobRemoved }
}

export const cache: typeof cacheComponent & { invalidate: typeof invalidate } = Object.assign(
  <C>(Comp: C, opts: Parameters<typeof cacheComponent>[1]): C => cacheComponent(Comp, opts),
  { invalidate },
)
export type { InvalidateArgs, InvalidateResult }
