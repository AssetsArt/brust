import type { BrustRequest, Middleware } from './routes.ts'

/** Server-side action handler. First arg is ALWAYS BrustRequest; the client
 * stub strips it from the call site. Subsequent args are JSON-decoded from
 * the request body (which MUST be a JSON array). */
export type ActionFn<Args extends unknown[] = unknown[], R = unknown> =
  (req: BrustRequest, ...args: Args) => Promise<R>

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

/** Identity helper that pins the actions array's element type. Parallels
 * defineRoutes. Use to keep TS inference happy across the boundary. */
export function defineActions(actions: ActionDef[]): ActionDef[] {
  return actions
}

/** Mirrors is_safe_action_id in src/lib.rs and src/server.rs.
 * Allowed: [A-Za-z0-9_-]+ only, max 128 chars. */
export function isValidActionId(id: string): boolean {
  if (id.length === 0 || id.length > 128) return false
  return /^[A-Za-z0-9_-]+$/.test(id)
}
