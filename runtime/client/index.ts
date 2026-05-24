/** Browser-only client helpers. This module is loaded by hydrated island
 * bundles. It intentionally does NOT import from runtime/routes.ts or
 * runtime/index.ts — those pull in React and server-side surface that the
 * client doesn't need.
 */

export class BrustActionError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly payload: unknown,
  ) {
    super(message)
    this.name = 'BrustActionError'
  }
}

/** Untyped server-fn shape used as the generic constraint. The client never
 * sees BrustRequest, so we type the leading req as `any` here — the helper
 * strips it from the call site via DropReq<F>. */
export type ServerFn = (req: any, ...args: any[]) => Promise<any>

/** Drop the leading `req` arg from F's parameter list. */
type DropReq<F> = F extends (req: any, ...args: infer A) => infer R
  ? (...args: A) => R
  : never

/** Build a typed RPC stub for an action.
 *
 * Usage:
 *   import type * as srv from '../actions'
 *   const createNote = action<typeof srv.createNote>('createNote')
 *   const { id } = await createNote('hello')  // typed Promise<{ id: string }>
 *
 * @param id  The action id — matches the named export from a `'use server'`
 *            file discovered by `brust.scanActions()`. Use `withMiddleware`
 *            to attach per-action middleware on the server side.
 */
export function action<F extends ServerFn>(id: string): DropReq<F> {
  return (async (...args: unknown[]) => {
    const res = await fetch(`/_brust/action/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    })
    const text = await res.text()
    if (!res.ok) {
      const parsed = safeParse(text)
      const message =
        (parsed && typeof parsed === 'object' && parsed !== null &&
         'error' in parsed && parsed.error && typeof parsed.error === 'object' &&
         'message' in parsed.error && typeof parsed.error.message === 'string')
          ? parsed.error.message
          : (text || 'action failed')
      throw new BrustActionError(message, res.status, parsed ?? text)
    }
    return text ? JSON.parse(text) : undefined
  }) as DropReq<F>
}

function safeParse(s: string): unknown | null {
  try { return JSON.parse(s) } catch { return null }
}
