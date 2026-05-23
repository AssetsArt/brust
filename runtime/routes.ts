import { createElement, type ComponentType, type ReactNode } from 'react'
import { renderToString } from 'react-dom/server'

export interface RouteContext<Params = Record<string, string>> {
  params: Params
  path: string
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

export interface Route<Params = Record<string, string>> {
  /** matchit syntax — use `/blog/{slug}` for parameters (NOT Express-style `:slug`). */
  path: string
  Component: ComponentType<RouteContext<Params>>
  /** Optional component invoked when Component (or, later, loader) throws. */
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
export function makeRenderer(
  routes: Route[],
  view: Uint8Array,
): (envelopeJson: string) => Promise<number> {
  const encoder = new TextEncoder()
  const byId = new Map<number, Route>()
  routes.forEach((r, i) => byId.set(i, r))

  return async (envelopeJson: string): Promise<number> => {
    const call = JSON.parse(envelopeJson) as RouteCall
    const route = byId.get(call.route_id)
    if (!route) {
      // Rust matched against the router but this worker's `routes` array doesn't
      // include this id. Indicates that registerRoutes(main) and makeRenderer(worker)
      // received different arrays — surface loudly rather than HTTP-500 silently.
      console.error(`[brust] unknown route_id=${call.route_id} for path=${call.path}`)
      return 0
    }
    let html: string
    try {
      html = renderToString(
        createElement(route.Component, { params: call.params, path: call.path }),
      )
    } catch (renderErr) {
      if (!route.errorBoundary) throw renderErr
      const boundary: ReactNode = createElement(route.errorBoundary, {
        error: renderErr instanceof Error ? renderErr : new Error(String(renderErr)),
      })
      html = renderToString(boundary as any)
    }
    const { written } = encoder.encodeInto(html, view)
    return written ?? 0
  }
}
