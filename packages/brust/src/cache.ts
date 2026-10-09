// Component-level cache declaration (S4 / §5). The compiler reads `cache(Comp, opts)` statically;
// at runtime it is identity. `cache.invalidate` drops L1 pages and job-cache entries in the
// running server (napi `cacheInvalidate`).
import { cacheComponent } from './cache-core'
import { type InvalidateArgs, type InvalidateResult, cacheInvalidate } from './native'

export type { ComponentCacheOptions } from './cache-core'

const NO_SERVER = 'cache.invalidate needs a running server (call it inside `brust start`)'

function invalidate(args: InvalidateArgs): InvalidateResult {
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
  return { l1Removed: r.l1Removed, jobRemoved: r.jobRemoved }
}

export const cache: typeof cacheComponent & { invalidate: typeof invalidate } = Object.assign(
  <C>(Comp: C, opts: Parameters<typeof cacheComponent>[1]): C => cacheComponent(Comp, opts),
  { invalidate },
)
export type { InvalidateArgs, InvalidateResult }
