// `@brust/core` under the `workerd` export condition (M4-CF, ruling c30e2633): the app-facing API a Worker can run.
// Same names as `index.ts` minus what needs a host process: no `run`, no `loadConfig`. `cache.invalidate` goes through
// the CF bundle's napi stub to the runtime the wasm glue installed at start (`server-handlers` `install`).
export { buildTime } from './build-time'

/** F495 `[server] base_path` (see index.ts). The Cloudflare build bakes the manifest's value into the Worker bundle (`process.env.BRUST_BASE_PATH` is a `define`), `''` at the root. */
export const basePath: string = typeof process === 'undefined' ? '' : (process.env.BRUST_BASE_PATH ?? '')
export { navigate } from './navigate'
export type { NavErrorDetail, NavLoadDetail, NavigateOptions, NavSuccessDetail, NavTrigger } from './navigate'
export { cache } from './cache'
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
