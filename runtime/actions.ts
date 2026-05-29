import type { BrustRequest, Middleware } from './routes.ts'

/** Server-side action handler. First arg is ALWAYS BrustRequest; the client
 * stub strips it from the call site. Subsequent args are JSON-decoded from
 * the request body (which MUST be a JSON array). */
export type ActionFn<Args extends unknown[] = unknown[], R = unknown> = (
  req: BrustRequest,
  ...args: Args
) => Promise<R>

/** Registration shape passed to brust.registerActions. */
export interface ActionDef<F extends ActionFn = ActionFn> {
  /** Stable id; must match the id used by `action<F>(id)` on the client.
   * Charset: [A-Za-z0-9_-]+ (enforced both in TS and in Rust). */
  id: string
  /** Handler. Receives req + JSON-decoded args. */
  fn: F
  /** Per-action middleware chain. Same Middleware type used by routes. */
  middleware?: Middleware[]
}

/** Mirrors is_safe_action_id in src/lib.rs and src/server.rs.
 * Allowed: [A-Za-z0-9_-]+ only, max 128 chars. */
export function isValidActionId(id: string): boolean {
  if (id.length === 0 || id.length > 128) return false
  return /^[A-Za-z0-9_-]+$/.test(id)
}

const BRUST_MW_KEY = '__brustMiddleware'

/** Attach a middleware chain to a server-action function. The function is
 * returned unchanged so the TypeScript signature is preserved verbatim —
 * callers can still write `typeof srv.deleteNote` on the client.
 *
 * Throws TypeError if `mws` isn't an array of functions.
 * Throws Error if called twice on the same fn (compose mws in one call).
 */
export function withMiddleware<F extends (...args: never[]) => unknown>(
  mws: readonly Middleware[],
  fn: F,
): F {
  if (!Array.isArray(mws) || mws.some((m) => typeof m !== 'function')) {
    throw new TypeError('withMiddleware expects an array of middleware functions')
  }
  if ((fn as { [BRUST_MW_KEY]?: unknown })[BRUST_MW_KEY] !== undefined) {
    throw new Error(
      'withMiddleware called twice on the same function — compose middleware in a single call instead',
    )
  }
  Object.defineProperty(fn, BRUST_MW_KEY, {
    value: Object.freeze([...mws]),
    enumerable: false,
    writable: false,
    configurable: false,
  })
  return fn
}

/** Read the middleware metadata installed by withMiddleware. Used by the
 * scanner to populate ActionDef.middleware. Returns undefined for plain
 * (un-wrapped) functions. */
export function getActionMiddleware(fn: unknown): Middleware[] | undefined {
  if (typeof fn !== 'function') return undefined
  return (fn as { [BRUST_MW_KEY]?: Middleware[] })[BRUST_MW_KEY]
}
