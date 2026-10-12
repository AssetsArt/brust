// What the generated Cloudflare entry (`brust-app.js`) imports: the host-agnostic handler code and the
// store-scoped action fetch. No Bun / worker_threads here; `actions-bridge`'s napi import is stubbed by the
// CF bundle (M4-CF R8).
import { type CfCacheBridge, type CfInstallExt, installCache } from './cache-adapter/workers'
import type { InvalidateArgs, InvalidateResult } from './native'

export { fetchInScope, noActions } from './actions-bridge'
export { jsonCall, makeHandlers } from './handlers'
export { flattenRoutes } from './routes'

/** What the wasm side hands over at start (`#[event(start]` -> `install({ invalidate, l2Count })`, ruling 19753649). */
export interface CfRuntime {
  invalidate(args: InvalidateArgs): InvalidateResult
  /** Bumps a `stats.l2` counter (cache adapters R9). */
  l2Count?(name: string): boolean
}
export type { CfCacheBridge, CfInstallExt }

let rt: CfRuntime | null = null

/** Called by the wasm glue once at Worker start; the CF bundle's napi stub forwards `cacheInvalidate` to it.
 * With a cache adapter (`ext`, from the generated entry) it answers the adapter bridge (R11, R14). */
export function install(runtime: CfRuntime, ext?: CfInstallExt): { cache: CfCacheBridge | null } {
  rt = runtime
  return { cache: ext ? installCache(runtime, ext) : null }
}

/** The installed runtime; throws before `install` (a request cannot arrive earlier). */
export function installedRuntime(): CfRuntime {
  if (!rt) throw new Error('brust: the Cloudflare runtime is not installed (install(rt) was not called at start)')
  return rt
}
