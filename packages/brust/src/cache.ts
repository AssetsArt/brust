// Component-level cache declaration (S4 / §5). The compiler reads `cache(Comp, opts)` statically;
// at runtime it is identity. `cache.invalidate` drops L1 pages and job-cache entries in the
// running server (napi `cacheInvalidate`).
import { type InvalidateArgs, type InvalidateResult, cacheInvalidate } from './native'

export interface ComponentCacheOptions {
  key?: (props: any) => unknown
  tags?: (props: any) => string[]
  revalidate?: number
}

function cacheComponent<C>(Comp: C, opts: ComponentCacheOptions): C {
  // Debugging aid only: the compiler, not this property, decides caching.
  if ((typeof Comp === 'function' || (typeof Comp === 'object' && Comp !== null)) && Object.isExtensible(Comp))
    Object.assign(Comp as object, { __brustCache: opts })
  return Comp
}

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

export const cache: typeof cacheComponent & { invalidate: typeof invalidate } = Object.assign(cacheComponent, { invalidate })
export type { InvalidateArgs, InvalidateResult }
