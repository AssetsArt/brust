// The side-effect-free half of `cache()` (no addon import): shared by `./cache` (server) and
// `./browser` (the `browser` export condition of `@brust/core`).

export interface ComponentCacheOptions {
  key?: (props: any) => unknown
  tags?: (props: any) => string[]
  revalidate?: number
}

export function cacheComponent<C>(Comp: C, opts: ComponentCacheOptions): C {
  // Debugging aid only: the compiler, not this property, decides caching.
  if ((typeof Comp === 'function' || (typeof Comp === 'object' && Comp !== null)) && Object.isExtensible(Comp))
    Object.assign(Comp as object, { __brustCache: opts })
  return Comp
}
