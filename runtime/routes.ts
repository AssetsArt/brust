import { createElement, type ComponentType, type ReactNode } from 'react'
import { renderToString } from 'react-dom/server'

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

/** Wire-level shape of the JSON envelope produced by Rust `routes::match_path`.
 * Keep this struct in sync with src/routes.rs::RouteEnvelope.
 */
export interface RouteCall {
  route_id: number
  path: string
  params: Record<string, string>
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
}

export function makeRenderer(
  routes: Route[],
  view: Uint8Array,
  opts: MakeRendererOptions = {},
): (envelopeJson: string) => Promise<number> {
  const encoder = new TextEncoder()
  const byId = new Map<number, Route>()
  routes.forEach((r, i) => byId.set(i, r))

  return async (envelopeJson: string): Promise<number> => {
    const call = JSON.parse(envelopeJson) as RouteCall
    const route = byId.get(call.route_id)
    if (!route) {
      console.error(`[brust] unknown route_id=${call.route_id} for path=${call.path}`)
      return 0
    }

    const workerId = opts.getWorkerId ? opts.getWorkerId() : null

    // Terminal `next()` — runs loader (if any), then renderToString. Wraps both
    // in a try/catch so errorBoundary catches both loader and render exceptions.
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
        return { status: 200, body: html }
      } catch (renderErr) {
        if (!route.errorBoundary) throw renderErr
        const boundary: ReactNode = createElement(route.errorBoundary, {
          error: renderErr instanceof Error ? renderErr : new Error(String(renderErr)),
        })
        const html = renderToString(boundary as any)
        return { status: 500, body: html }
      }
    }

    // Compose middleware chain right-to-left so the first entry runs outermost.
    // Each link calls the next via `next()`; returning without calling next()
    // short-circuits the chain.
    let chain = terminal
    if (route.middleware && route.middleware.length > 0) {
      for (let i = route.middleware.length - 1; i >= 0; i--) {
        const mw = route.middleware[i]
        const next = chain
        chain = () => mw(call.req, next)
      }
    }

    let response: RouteResponse
    try {
      response = await chain()
    } catch (err) {
      // A middleware (or terminal without errorBoundary) raised. Render as 500
      // text/plain inside the envelope so the wire response is still valid.
      console.error(`[brust] middleware/render uncaught:`, err)
      response = {
        status: 500,
        body: 'internal error',
      }
    }

    // Pack the meta JSON envelope: [meta_len u16 BE][meta JSON][body].
    const meta = response.headers
      ? { status: response.status, headers: response.headers }
      : { status: response.status }
    const metaBytes = encoder.encode(JSON.stringify(meta))
    if (metaBytes.length > 0xffff) {
      console.error(`[brust] meta too large: ${metaBytes.length} bytes`)
      return 0
    }
    if (2 + metaBytes.length + 1 > view.length) {
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
}
