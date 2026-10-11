// `@brust/core/elysia` (M3-F E2, ruling R2): the adapter an actions app is built with. Rust owns
// HTTP; the worker drives the app with `app.fetch(request)`. Elysia 2.0.0-beta.30's adapter is
// `{ listen?, parse, response, setup? }` (elysia/adapter/types.d.ts); `name` is brust's own tag.
import type { ElysiaAdapter } from 'elysia/adapter'
import { WebStandardAdapter } from 'elysia/adapter/web-standard'

export const LISTEN_ERROR = 'brust actions are served by the Rust server — remove app.listen()'
export type BrustAdapter = ElysiaAdapter & { readonly name: 'brust' }

export function brust(): BrustAdapter {
  return { ...WebStandardAdapter, name: 'brust', listen() { throw new Error(LISTEN_ERROR) } }
}
export function isBrustAdapter(a: unknown): a is BrustAdapter {
  return typeof a === 'object' && a !== null && (a as { name?: unknown }).name === 'brust'
}
