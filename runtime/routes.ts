import { createElement, type ComponentType, type ReactNode } from 'react'
import { renderToString } from 'react-dom/server'
import { consumeIslandUsedFlag } from './islands/island.tsx'
import type { ActionDef } from './actions.ts'

/** Structured view of the request, parsed once in Rust and shipped in the
 * JSON envelope. Header names are lower-cased. Cookies are parsed from the
 * Cookie header. `search` is the query string parsed as key→value (last
 * occurrence wins on duplicates). */
export interface BrustRequest {
  method: string
  /** Full request URL path including query string, e.g. `/foo?bar=1`. */
  url: string
  headers: Record<string, string>
  cookies: Record<string, string>
  search: Record<string, string>
}

export interface RouteContext<Params = Record<string, string>, Data = unknown> {
  params: Params
  path: string
  /** Value returned by `route.loader`. Undefined if the route has no loader. */
  data: Data
  /** Bun Worker id rendering this request. null before the first registerRenderer
   * return resolves (a brief window during boot). */
  workerId: number | null
  /** Structured request shape. Available to components for read-only inspection. */
  req: BrustRequest
}

export interface ErrorBoundaryProps {
  error: Error
}

export interface RouteCacheConfig {
  /** Time-to-live in seconds. */
  ttl_seconds: number
  /** Request headers that affect content. Each becomes part of the cache key. */
  vary?: string[]
}

/** Shape returned by a middleware or by the terminal `next()` (loader + render).
 * Middleware can short-circuit by returning a RouteResponse without calling next,
 * or call next() and mutate the returned response (status, headers). */
export interface RouteResponse {
  status: number
  body: string
  /** Extra response headers. Names are case-insensitive on the wire; Rust
   * deduplicates by lower-casing internally. Skips collisions with the fixed
   * Content-Type / Content-Length / Connection lines. */
  headers?: Record<string, string>
  /** Override the Content-Type emitted by Rust. Action returns set this to
   * 'application/json; charset=utf-8'; middleware short-circuits with a
   * raw string body can set 'text/plain'. Falls back to 'text/html' (render)
   * or 'application/json' (action) when omitted. */
  contentType?: string
}

/** Middleware contract — Express/Koa-style chain. Receives a structured
 * request and a `next()` that runs the rest of the chain (eventually the
 * loader + render). Return a `RouteResponse` to short-circuit, or call
 * `await next()` and return its (possibly mutated) result. */
export type Middleware = (
  req: BrustRequest,
  next: () => Promise<RouteResponse>,
) => Promise<RouteResponse>

export interface Route<Params = Record<string, string>, Data = unknown> {
  /** matchit syntax — use `/blog/{slug}` for parameters (NOT Express-style `:slug`). */
  path: string
  Component: ComponentType<RouteContext<Params, Data>>
  /** Optional async function that runs in the worker before rendering. Its
   * return value becomes the component's `data` prop. Exceptions are caught
   * by `errorBoundary` if declared. */
  loader?: (ctx: { params: Params; path: string; req: BrustRequest }) => Promise<Data>
  /** Optional component invoked when Component or loader throws. */
  errorBoundary?: ComponentType<ErrorBoundaryProps>
  /** Opt-in cache. Omit for no caching (default for authed/personalised routes). */
  cache?: RouteCacheConfig
  /** Per-route middleware chain. Runs in declaration order; each middleware
   * wraps the next. Cache lookup happens BEFORE middleware runs — cached
   * responses skip the chain entirely. */
  middleware?: Middleware[]
}

/** Identity helper that pins the `routes` array's element type for the IDE
 * and ensures route_ids are stable across worker reloads (they = array index).
 */
export function defineRoutes(routes: Route[]): Route[] {
  return routes
}

/** Wire-level shape of the JSON envelope produced by Rust. Discriminated
 * union: render path (matched against a route) vs action path
 * (POST /_brust/action/<id>). Keep these in sync with src/routes.rs
 * RouteEnvelope / ActionEnvelope.
 */
export type RouteCall =
  | {
      kind: 'render'
      route_id: number
      path: string
      params: Record<string, string>
      req: BrustRequest
    }
  | {
      kind: 'action'
      action_id: string
      /** Raw JSON args body (a JSON string). Worker parses it once,
       * checks Array.isArray, then spreads into the action handler. */
      args_json: string
      req: BrustRequest
    }

/**
 * Build a render callback for a given routes table. The returned function is
 * what gets passed to `brust.registerRenderer(view, fn)` on the worker side.
 *
 * Wire format written to the SAB: [meta_len: u16 BE][meta JSON UTF-8][body bytes].
 * meta = { status: number, headers?: Record<string, string> }.
 */
export interface MakeRendererOptions {
  /** Lazy getter for the Bun Worker id. Called per-render so the value can be
   * resolved after `registerRenderer` returns. Returns null before that. */
  getWorkerId?: () => number | null
  /** Action table the worker dispatches to when envelope.kind === 'action'.
   * Pass the SAME array given to brust.registerActions on the main thread —
   * the wire keys (ids) and the handler functions (fn) must agree. */
  actions?: ActionDef[]
}

export function makeRenderer(
  routes: Route[],
  view: Uint8Array,
  opts: MakeRendererOptions = {},
): (envelopeJson: string) => Promise<number> {
  const encoder = new TextEncoder()
  const byRouteId = new Map<number, Route>()
  routes.forEach((r, i) => byRouteId.set(i, r))
  const byActionId = new Map<string, ActionDef>()
  for (const a of opts.actions ?? []) byActionId.set(a.id, a)

  return async (envelopeJson: string): Promise<number> => {
    const call = JSON.parse(envelopeJson) as RouteCall

    if (call.kind === 'render') {
      return renderBranch(call, byRouteId, view, encoder, opts.getWorkerId)
    }
    if (call.kind === 'action') {
      return actionBranch(call, byActionId, view, encoder)
    }
    // Unknown kind — log and 500. Shouldn't happen unless Rust ships
    // something out of band.
    console.error(`[brust] unknown envelope kind in worker:`, (call as { kind?: string }).kind)
    return packResponse(view, encoder, {
      status: 500,
      body: 'invalid envelope kind',
      contentType: 'text/plain; charset=utf-8',
    })
  }
}

async function renderBranch(
  call: Extract<RouteCall, { kind: 'render' }>,
  byId: Map<number, Route>,
  view: Uint8Array,
  encoder: TextEncoder,
  getWorkerId?: () => number | null,
): Promise<number> {
  const route = byId.get(call.route_id)
  if (!route) {
    console.error(`[brust] unknown route_id=${call.route_id} for path=${call.path}`)
    return 0
  }
  const workerId = getWorkerId ? getWorkerId() : null

  const terminal = async (): Promise<RouteResponse> => {
    try {
      const data = route.loader
        ? await route.loader({ params: call.params, path: call.path, req: call.req })
        : undefined
      const html = renderToString(
        createElement(route.Component, {
          params: call.params,
          path: call.path,
          data,
          workerId,
          req: call.req,
        }),
      )
      const wrapped = consumeIslandUsedFlag()
        ? wrapWithIslandsBootstrap(html)
        : html
      return { status: 200, body: wrapped }
    } catch (renderErr) {
      if (!route.errorBoundary) throw renderErr
      const boundary: ReactNode = createElement(route.errorBoundary, {
        error: renderErr instanceof Error ? renderErr : new Error(String(renderErr)),
      })
      const html = renderToString(boundary)
      const wrapped = consumeIslandUsedFlag()
        ? wrapWithIslandsBootstrap(html)
        : html
      return { status: 500, body: wrapped }
    }
  }

  const chain = composeChain(call.req, route.middleware, terminal)

  let response: RouteResponse
  try {
    response = await chain()
  } catch (err) {
    console.error(`[brust] middleware/render uncaught:`, err)
    response = { status: 500, body: 'internal error' }
  }
  return packResponse(view, encoder, response)
}

async function actionBranch(
  call: Extract<RouteCall, { kind: 'action' }>,
  byId: Map<string, ActionDef>,
  view: Uint8Array,
  encoder: TextEncoder,
): Promise<number> {
  const def = byId.get(call.action_id)
  if (!def) {
    // Rust already 404s when the id isn't registered, but a race during
    // hot-reload (or a desynced worker) could land here. Log and 404.
    // NOTE: asymmetric with renderBranch (which returns 0 to delegate to
    // Rust's HTML 404). Action clients always expect JSON, so we ship a
    // JSON envelope here even when Rust would have 404'd first.
    console.error(`[brust] unknown action_id=${call.action_id}`)
    return packResponse(view, encoder, {
      status: 404,
      body: '{"error":{"message":"unknown action"}}',
      contentType: 'application/json; charset=utf-8',
    })
  }

  // Parse args BEFORE middleware so a malformed body 400s without running
  // any user code.
  let args: unknown[]
  try {
    const decoded = JSON.parse(call.args_json) as unknown
    if (!Array.isArray(decoded)) {
      return packResponse(view, encoder, {
        status: 400,
        body: '{"error":{"message":"args must be a JSON array"}}',
        contentType: 'application/json; charset=utf-8',
      })
    }
    args = decoded
  } catch {
    return packResponse(view, encoder, {
      status: 400,
      body: '{"error":{"message":"invalid args JSON"}}',
      contentType: 'application/json; charset=utf-8',
    })
  }

  const terminal = async (): Promise<RouteResponse> => {
    try {
      const result = await def.fn(call.req, ...args)
      return {
        status: 200,
        body: result === undefined ? '' : JSON.stringify(result),
        contentType: 'application/json; charset=utf-8',
      }
    } catch (err) {
      console.error(`[brust] action ${def.id} threw:`, err)
      const e = err instanceof Error ? err : new Error(String(err))
      return {
        status: 500,
        body: JSON.stringify({ error: { message: e.message, name: e.name } }),
        contentType: 'application/json; charset=utf-8',
      }
    }
  }

  const chain = composeChain(call.req, def.middleware, terminal)

  let response: RouteResponse
  try {
    response = await chain()
  } catch (err) {
    console.error(`[brust] action middleware uncaught:`, err)
    response = {
      status: 500,
      body: JSON.stringify({ error: { message: 'internal error' } }),
      contentType: 'application/json; charset=utf-8',
    }
  }
  return packResponse(view, encoder, response)
}

/** Right-to-left compose a middleware chain. Each middleware wraps the next;
 * the terminal step ends up at the innermost call. Returning without calling
 * next() short-circuits. Used identically by render + action branches. */
function composeChain(
  req: BrustRequest,
  mws: Middleware[] | undefined,
  terminal: () => Promise<RouteResponse>,
): () => Promise<RouteResponse> {
  if (!mws || mws.length === 0) return terminal
  let chain = terminal
  for (let i = mws.length - 1; i >= 0; i--) {
    const mw = mws[i]
    const next = chain
    chain = () => mw(req, next)
  }
  return chain
}

/** Pack a RouteResponse into the SAB and return the byte count.
 * Wire format: [meta_len: u16 BE][meta JSON UTF-8][body bytes].
 * meta = { status, headers?, contentType? }
 *
 * MUST remain synchronous — Rust per-worker call serialisation (via
 * pool.pick_least_busy + in_flight_guard) only holds if the JS handler
 * doesn't yield between SAB writes. If this ever becomes async (e.g.,
 * for compression), revisit the pool dispatch invariants first.
 */
function packResponse(
  view: Uint8Array,
  encoder: TextEncoder,
  response: RouteResponse,
): number {
  const meta: { status: number; headers?: Record<string, string>; contentType?: string } = {
    status: response.status,
  }
  if (response.headers) meta.headers = response.headers
  if (response.contentType) meta.contentType = response.contentType

  const metaBytes = encoder.encode(JSON.stringify(meta))
  if (metaBytes.length > 0xffff) {
    console.error(`[brust] meta too large: ${metaBytes.length} bytes`)
    return 0
  }
  if (2 + metaBytes.length > view.length) {
    console.error(`[brust] envelope > SAB capacity`)
    return 0
  }
  view[0] = (metaBytes.length >> 8) & 0xff
  view[1] = metaBytes.length & 0xff
  view.set(metaBytes, 2)
  const bodyView = view.subarray(2 + metaBytes.length)
  const { written } = encoder.encodeInto(response.body, bodyView)
  if (written === undefined) return 0
  return 2 + metaBytes.length + written
}

const ISLANDS_IMPORTMAP_AND_BOOTSTRAP =
  '<script type="importmap">' +
  JSON.stringify({
    imports: {
      // Both react and react/jsx-runtime resolve to the SAME chunk; the
      // chunk re-exports both surfaces. Browser fetches it once and slices
      // different named exports for each import statement.
      'react': '/_brust/islands/_react.js',
      'react/jsx-runtime': '/_brust/islands/_react.js',
      'react-dom/client': '/_brust/islands/_react-dom.js',
    },
  }) +
  '</script>' +
  '<script type="module" src="/_brust/islands/_bootstrap.js" defer></script>'

/** Prepend the importmap + bootstrap <script> tags to the rendered HTML.
 * Browsers tolerate <script> before <html>; this works for full-document
 * SSR (`<html><body>...`) and for body fragments alike. */
function wrapWithIslandsBootstrap(html: string): string {
  return ISLANDS_IMPORTMAP_AND_BOOTSTRAP + html
}
