// What the generated Cloudflare entry (`brust-app.js`) imports: the host-agnostic handler code and the
// store-scoped action fetch. No Bun / worker_threads here; `actions-bridge`'s napi import is stubbed by the
// CF bundle (M4-CF R8).
import type { InvalidateArgs, InvalidateResult } from './native'

export { fetchInScope, noActions } from './actions-bridge'
export { jsonCall, makeHandlers } from './handlers'
export { flattenRoutes } from './routes'

/** What the wasm side hands over at start (`#[event(start]` -> `install({ invalidate })`, ruling 19753649). */
export interface CfRuntime {
  invalidate(args: InvalidateArgs): InvalidateResult
}

let rt: CfRuntime | null = null

/** Called by the wasm glue once at Worker start; the CF bundle's napi stub forwards `cacheInvalidate` to it. */
export function install(runtime: CfRuntime): void {
  rt = runtime
}

/** The installed runtime; throws before `install` (a request cannot arrive earlier). */
export function installedRuntime(): CfRuntime {
  if (!rt) throw new Error('brust: the Cloudflare runtime is not installed (install(rt) was not called at start)')
  return rt
}
