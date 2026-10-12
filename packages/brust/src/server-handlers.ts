// What the generated Cloudflare entry (`brust-app.js`) imports: the host-agnostic handler code and the
// store-scoped action fetch. No Bun / worker_threads here; `actions-bridge`'s napi import is stubbed by the
// CF bundle (M4-CF R8).
export { fetchInScope, noActions } from './actions-bridge'
export { jsonCall, makeHandlers } from './handlers'
export { flattenRoutes } from './routes'
