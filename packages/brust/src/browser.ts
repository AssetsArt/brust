// `@brust/brust` under the `browser` export condition (and what every browser bundle of
// `brust build` resolves the package root to): only the side-effect-free pieces. No `run`, no
// config, no napi addon — a react island may import `cache` from the package root.
import { cacheComponent } from './cache-core'
import type { InvalidateArgs, InvalidateResult } from './native'

function invalidate(_args: InvalidateArgs): InvalidateResult {
  throw new Error('cache.invalidate is server-only (call it inside `brust start`, not in the browser)')
}

export const cache: typeof cacheComponent & { invalidate: typeof invalidate } = Object.assign(
  <C>(Comp: C, opts: Parameters<typeof cacheComponent>[1]): C => cacheComponent(Comp, opts),
  { invalidate },
)
export type { ComponentCacheOptions } from './cache-core'
export type { InvalidateArgs, InvalidateResult }
export {
  ALLOWED_ROUTE_FIELDS,
  BrustRouteError,
  defineRoutes,
  flattenRoutes,
  httpError,
  isHttpErrorTrigger,
  isVerdict,
  notFound,
  Outlet,
  redirect,
} from './routes'
export type { ComponentType, FlatRoute, HttpErrorOpts, HttpErrorTrigger, LoaderCtx, LoaderReq, Route, RouteCacheConfig, Verdict } from './routes'
