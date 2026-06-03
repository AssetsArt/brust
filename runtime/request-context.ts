// This module imports a Node builtin (node:async_hooks) and therefore must NOT
// be reachable from browser/island bundles (brustjs/client) or from the
// isomorphic store entry (brustjs/store). It mirrors store/server-context.ts:
// the server pulls it in via routes.ts, where each request is wrapped in a
// per-request scope. cookies.ts reaches the active scope through __scope().
import { AsyncLocalStorage } from 'node:async_hooks'

interface RequestScope {
  ctx: Map<string, unknown>
  reqCookies: Record<string, string>
  setCookies: string[]
}

const reqCtx = new AsyncLocalStorage<RequestScope>()

/** Open a per-request scope. `reqCookies` is the parsed incoming Cookie header
 * (BrustRequest.cookies). Staged Set-Cookie strings accumulate in `setCookies`
 * and are flushed by routes.ts onto the response headers. */
export function runInRequestScope<T>(reqCookies: Record<string, string>, fn: () => T): T {
  return reqCtx.run({ ctx: new Map(), reqCookies, setCookies: [] }, fn)
}

/** Per-request scratch Map for apps building request-scoped state on top of the
 * module-global store. Throws when called outside a request scope. */
export function getRequestContext(): Map<string, unknown> {
  const s = reqCtx.getStore()
  if (!s) throw new Error('getRequestContext() called outside a request scope')
  return s.ctx
}

/** Internal — the active scope (or undefined). Used by cookies.ts and the
 * routes.ts flush. Not re-exported from the package entry. */
export function __scope(): RequestScope | undefined {
  return reqCtx.getStore()
}
