/// <reference path="./css-modules.d.ts" />
/// <reference path="./assets.d.ts" />
// `@brust/core`: the app-facing API.
export { buildTime } from './build-time'

/** F495 `[server] base_path`: the path the app is mounted under (`/portal`), `''` at the root. Read-only: build URLs with it
 * (`${basePath}/_brust/…` is brust's own; every URL you write is already the real one). Set from the manifest (`brust start`) or the
 * config (`brust build`) before the app's modules load. */
export const basePath: string = process.env.BRUST_BASE_PATH ?? ''
export { clearNavigationCache, navigate } from './navigate'
export type { NavErrorDetail, NavLoadDetail, NavigateOptions, NavSuccessDetail, NavTrigger } from './navigate'
export { cache } from './cache'
export { type BrustConfig, BrustConfigError, loadConfig } from './config'
export { type RunOptions, run } from './run'
export type { ComponentCacheOptions, InvalidateArgs, InvalidateResult } from './cache'
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
export type { ComponentType, FlatRoute, HttpErrorOpts, HttpErrorTrigger, LoaderCtx, LoaderReq, Route, RouteCacheConfig, RouteSsgConfig, Verdict } from './routes'
