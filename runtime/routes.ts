import { createElement, type ComponentType, type ReactNode } from 'react'
import { renderToString } from 'react-dom/server'

export interface RouteContext<Params = Record<string, string>, Data = unknown> {
  params: Params
  path: string
  /** Value returned by `route.loader`. Undefined if the route has no loader. */
  data: Data
  /** Bun Worker id rendering this request. null before the first registerRenderer
   * return resolves (a brief window during boot). */
  workerId: number | null
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

export interface Route<Params = Record<string, string>, Data = unknown> {
  /** matchit syntax — use `/blog/{slug}` for parameters (NOT Express-style `:slug`). */
  path: string
  Component: ComponentType<RouteContext<Params, Data>>
  /** Optional async function that runs in the worker before rendering. Its
   * return value becomes the component's `data` prop. Exceptions are caught
   * by `errorBoundary` if declared. */
  loader?: (ctx: { params: Params; path: string }) => Promise<Data>
  /** Optional component invoked when Component or loader throws. */
  errorBoundary?: ComponentType<ErrorBoundaryProps>
  /** Opt-in cache. Omit for no caching (default for authed/personalised routes). */
  cache?: RouteCacheConfig
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
}

/**
 * Build a render callback for a given routes table. The returned function is
 * what gets passed to `brust.registerRenderer(view, fn)` on the worker side.
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

    let html: string
    let status = 200
    try {
      // Loader runs first (if declared). Exceptions flow into the same catch
      // as render exceptions — errorBoundary handles both uniformly.
      const data = route.loader
        ? await route.loader({ params: call.params, path: call.path })
        : undefined
      html = renderToString(
        createElement(route.Component, { params: call.params, path: call.path, data, workerId }),
      )
    } catch (renderErr) {
      if (!route.errorBoundary) throw renderErr
      const boundary: ReactNode = createElement(route.errorBoundary, {
        error: renderErr instanceof Error ? renderErr : new Error(String(renderErr)),
      })
      html = renderToString(boundary as any)
      status = 500
    }

    // Wire format: [status_u16_BE][body bytes].
    view[0] = (status >> 8) & 0xff
    view[1] = status & 0xff
    const bodyView = view.subarray(2)
    const { written } = encoder.encodeInto(html, bodyView)
    if (written === undefined) return 0
    return written + 2
  }
}
