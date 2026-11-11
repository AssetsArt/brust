// `@brust/core/elysia` (M3-F E2, ruling R2): the adapter an actions app is built with. Rust owns
// HTTP; the worker drives the app with `app.fetch(request)`. Elysia 2.0.0-rc.4's adapter is
// `{ listen?, parse, response, setup? }` (elysia/adapter/types.d.ts); `name` is brust's own tag.
import type { AnyElysia } from 'elysia'
import type { ElysiaAdapter } from 'elysia/adapter'
import { WebStandardAdapter } from 'elysia/adapter/web-standard'

export const LISTEN_ERROR = 'brust actions are served by the Rust server — remove app.listen()'
export type BrustAdapter = ElysiaAdapter & { readonly name: 'brust' }

/** F529: `websocket()` from `elysia/websocket`, registered by a Bun-target worker before it imports the app (see
 * `loadActionsApp`). Absent on Cloudflare, so `.ws()` there fails at startup with Elysia's own capability error and the
 * websocket module stays out of that bundle. */
type WsCapability = () => AnyElysia
let wsCapability: WsCapability | null = null
export function setWebSocketCapability(c: WsCapability | null): void {
  wsCapability = c
}

export function brust(): BrustAdapter {
  return {
    ...WebStandardAdapter,
    name: 'brust',
    listen() { throw new Error(LISTEN_ERROR) },
    // D2: `.ws()` needs a capability provider; the adapter supplies it on the Bun target only.
    setup: (app) => (wsCapability ? app.use(wsCapability()) : app),
  }
}
export function isBrustAdapter(a: unknown): a is BrustAdapter {
  return typeof a === 'object' && a !== null && (a as { name?: unknown }).name === 'brust'
}
