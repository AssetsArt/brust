import { createContext, createElement, useContext, type ComponentType, type ReactNode } from 'react'
// React 19 split react-dom/server by runtime: under Bun the bare 'react-dom/server'
// resolves to the web-streams build (server.bun.js), which only exports
// renderToReadableStream. renderToPipeableStream (Node streams — what our Writable
// sink + onAllReady/onShellReady path uses) lives in the .node build. Import it
// explicitly so SSR works on the react@19 we declare as a peer (React 18 shipped
// renderToPipeableStream in the bun build, which is why this was silently fine).
import { renderToPipeableStream } from 'react-dom/server.node'
import { Writable } from 'node:stream'
import { Buffer } from 'node:buffer'
import * as native from './index.js'
import { renderBranchStreaming } from './render/stream.ts'
import { runInStoreContext, collectSnapshot } from './store/server-context.ts'
import { buildStoreScripts } from './render/inject-store.ts'
import { getCssHrefsForRoute } from './css.ts'
import { runInRequestCache } from './loader-cache.ts'
import { runInRequestScope, __scope } from './request-context.ts'
import {
  loadIslandManifest,
  resolveIslandContext,
  loadComponentManifest,
  resolveComponentContext,
} from './islands/native-render.ts'
import type { IslandCache } from './islands/native-render.ts'
import { isActionError, type ActionError, type ActionErrorBody } from './action-error.ts'
import type { EndpointDef } from './define-actions.ts'
import { isRespondSentinel, makeRespond } from './define-actions.ts'
import { validate } from './standard-schema.ts'

// Markdown pages (task 2.11): the md API is part of the `brustjs/routes`
// surface — apps spread `...mdRoutes('content/docs', …)` into defineRoutes and
// render sidebars from `mdNav(...)`. Re-exported here so user code never
// imports runtime-internal paths.
export { mdNav, mdRoutes, mdUrlPath } from './md/routes.ts'
export type {
  MdNavGroup,
  MdNavItem,
  MdRoute,
  MdRoutesOptions,
  MdRouteSource,
} from './md/routes.ts'
// Lower-level md building blocks — the directory scanner and the heading
// slugger — so consumers (search indexers, sitemaps) build on the SAME
// scan/slug brust uses internally instead of copying it (FRAMEWORK-GAPS G1).
export { scanMdDir } from './md/scan.ts'
export type { MdFile } from './md/scan.ts'
export { slugifyHeading } from './md/slug.ts'

// S2 + B3 — unified per-request scope. The request scope (B3 cookies/context) is
// the OUTERMOST layer, then the request-scoped loader cache/dedupe (S2: one Map
// per request for `cachedFetch`/`dedupe` across loaders AND render), then the
// store scope (per-request store instance). `reqCookies` is the parsed incoming
// Cookie header so a loader's `cookies.get` reads it and `cookies.set` stages
// onto this scope (flushed onto response headers via flushSetCookie).
function runInRequestContext<T>(reqCookies: Record<string, string>, fn: () => T): T {
  return runInRequestScope(reqCookies, () => runInRequestCache(() => runInStoreContext(fn)))
}

// Sub-project J — island ISR cache, backed by the Rust-side store (shared across
// the worker pool) via NAPI. napi-rs maps snake→camel: island_cache_get →
// islandCacheGet, island_cache_set → islandCacheSet. `as any` avoids depending on
// the regenerated .d.ts — the addon isn't rebuilt locally; index.js/*.node are
// gitignored and CI rebuilds. Optional-chaining (`?.`) means a STALE addon (built
// before these exports existed) degrades gracefully: get → undefined → null (a
// cache miss → normal render), set → no-op. Caching is an enhancement, never a
// hard dependency — unlike napiRenderJinja which has no fallback.
const islandCache: IslandCache = {
  get(key) {
    return (native as any).islandCacheGet?.(key) ?? null
  },
  set(key, tags, ttlMs, html, props) {
    ;(native as any).islandCacheSet?.(key, tags, ttlMs, html, props)
  },
}

// Permanently-unaborted AbortSignal sentinel for non-SSE routes.
// The controller is held in module scope and never .abort()-ed, keeping
// the signal alive in the unaborted state. Do NOT use AbortSignal.abort()
// — that creates an already-aborted signal which would fire any
// addEventListener('abort') listener synchronously and break defensive
// cleanup code.
const _neverAbortsController = new AbortController()
export const NEVER_ABORTS: AbortSignal = _neverAbortsController.signal

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
  /** AbortSignal that fires when the client disconnects mid-request.
   * SSE-only in MVP — non-SSE routes receive NEVER_ABORTS (a permanently-
   * unaborted shared sentinel; signal.aborted === false forever). Real
   * disconnect detection for render/action is a follow-up. */
  signal: AbortSignal
}

/** Handler module shape — what `() => Promise<WsHandlers>` resolves to.
 *  open/message/close are all OPTIONAL — a no-op WebSocket (handshake
 *  only, e.g. liveness probe) is a valid use case. */
export interface WsHandlers {
  /** Called once after the 101 handshake completes. Use this to record
   * the socket in your in-memory map, send a hello frame, etc.
   * Throwing here closes the conn with 1011 (Internal Error); on_close
   * does NOT fire (we never reached steady state). */
  open?: (
    socket: WsSocket,
    ctx: { req: BrustRequest; subprotocol: string | null },
  ) => void | Promise<void>
  /** Called per incoming message frame. data is string for Text frames,
   * Uint8Array for Binary. Throwing here is logged but the conn stays
   * open — one bad message shouldn't kill the conn; wrap in try/catch
   * for strict-close semantics. */
  message?: (socket: WsSocket, data: string | Uint8Array) => void | Promise<void>
  /** Called exactly ONCE when the conn closes EXCEPT when the author
   * called socket.close themselves. Code/reason from the RFC 6455
   * close frame; 1006 for abnormal (RST), 1011 for pong timeout,
   * 1001 for server shutdown. */
  close?: (socket: WsSocket, code: number, reason: string) => void
}

/** The only handle the author touches inside a WsHandlers callback. */
export interface WsSocket {
  /** Send a frame. Text if data is string, Binary if Uint8Array. Returns
   * a Promise that resolves when the TCP write completes (cooperative
   * backpressure, same model as SSE napi.write). Rejects with a clear
   * error if the conn is already closed. */
  send(data: string | Uint8Array): Promise<void>
  /** Initiate close with optional code (default 1000) and reason (default
   * ''). Idempotent — second call is a no-op. on_close does NOT fire
   * after this call. */
  close(code?: number, reason?: string): void
  /** Stable per-conn identifier. Useful as a Map key in author's
   * in-memory connection registry. */
  readonly id: bigint
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

/** L2 programmatic cache-key result. The `key` function builds the COMPLETE
 * cache key (you concat url + query + DB-derived data yourself). */
export interface CacheKeyResult {
  /** The COMPLETE L2 cache key. */
  key: string
  /** Tag groups for `cache.invalidate({ tags })`. */
  tags?: string[]
  /** Seconds; overrides `key_ttl_seconds` / `ttl_seconds`. */
  ttl?: number
}

export interface RouteCacheConfig<Params = Record<string, string>> {
  /** Base TTL in seconds (L1; L2 fallback). */
  ttl_seconds: number
  /** L1 declarative key prefix expression (evaluated in Rust, zero-Bun on hit). */
  prefix?: string
  /** Route to L2 when truthy: a key-expression (conditional) or `true` (always).
   * Absent / `false` ⇒ L1 only. */
  bypass?: string | boolean
  /** L2 programmatic key (runs in the worker). Returns the COMPLETE key. */
  key?: (ctx: {
    req: BrustRequest
    url: URL
    params: Params
  }) => CacheKeyResult | Promise<CacheKeyResult>
  /** Static L2 TTL (seconds); `CacheKeyResult.ttl` overrides per-entry. */
  key_ttl_seconds?: number
  /** Static L1 invalidation tags. L1 entries cached for this route carry these
   * tags so `cache.invalidate({ tags })` evicts them (L1 is no longer
   * TTL-only). Route-level + static — not per-request. */
  tags?: string[]
}

/** SSG config — read ONLY by `brust build --ssg`. Live server / dev ignore it.
 * See docs/superpowers/specs/2026-06-12-ssg-dynamic-params-design.md. */
export interface RouteSsgConfig {
  /** generateStaticParams: concrete param records to prerender. Each record
   * must cover every `{name}` in the route's full path with a non-empty
   * string. Sync or async. Values are URL-encoded into the crawl path. */
  params?: () => Array<Record<string, string>> | Promise<Array<Record<string, string>>>
  /** What non-prerendered paths do on a static host. 'none' (default) = skip
   * → host 404 (today's behavior). 'client' = client-loader takeover
   * (Phase B; requires `export const clientLoader` in the leaf component
   * file, leaf must be a DEFAULT import in routes.tsx, React routes only). */
  fallback?: 'none' | 'client'
  /** Server-rendered loading UI baked into the fallback shell (Phase B).
   * Renders in the leaf position with NO data. */
  placeholder?: ComponentType
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

const BRUST_VERDICT = Symbol.for('brust.nativeVerdict')

/** Sentinel returned from a native (`native: true`) route loader to control the
 * HTTP response. Build it with `notFound()` / `redirect()`, never by hand. */
export interface NativeVerdict {
  readonly [BRUST_VERDICT]: true
  readonly status: number
  readonly render: boolean
  readonly data?: unknown
  readonly headers?: Record<string, string>
}

/** Return from a native route loader to render the route's OWN template with
 * HTTP 404. `data` (default `{}`) becomes the template context. */
export function notFound(data?: unknown): NativeVerdict {
  return { [BRUST_VERDICT]: true, status: 404, render: true, data: data ?? {} }
}

/** Return from a native route loader to emit a redirect (no template render). */
export function redirect(
  location: string,
  status: 301 | 302 | 303 | 307 | 308 = 302,
): NativeVerdict {
  return { [BRUST_VERDICT]: true, status, render: false, headers: { Location: location } }
}

/** True if a loader return value is a NativeVerdict (symbol-keyed — a plain
 * object with a `status` property is NOT mistaken for one). */
export function isNativeVerdict(x: unknown): x is NativeVerdict {
  return (
    typeof x === 'object' && x !== null && (x as Record<symbol, unknown>)[BRUST_VERDICT] === true
  )
}

/** Loader context passed to native chain loaders. */
export interface NativeLoaderCtx {
  params: Record<string, string>
  path: string
  req: BrustRequest
}

/** Result of running a native route's chain loaders top-down: either a merged
 * flat context object (all loader results shallow-merged, child keys win), or
 * the first verdict encountered (top-down) which short-circuits the chain. */
export type NativeChainResult = { data: Record<string, unknown> } | { verdict: NativeVerdict }

/** Run a native route's `flat.chain` loaders top-down (parent → leaf) and merge
 * their results into ONE flat context object.
 *
 * Semantics (T3 — native <Outlet> loader chain):
 *  - Each chain node may lack a loader → skip it.
 *  - Results merge shallow: `merged = { ...merged, ...result }` — later (child)
 *    keys win over earlier (parent) keys.
 *  - First verdict wins: if any loader returns a `notFound()`/`redirect()`
 *    verdict (top-down), STOP — remaining loaders are NOT run — and return it.
 *  - `chain.length === 1` (or only the leaf has a loader) → behaves exactly as
 *    the old leaf-only read (no regression).
 *
 * The caller is responsible for wrapping this in a SINGLE `runInStoreContext`
 * (one Map per request) so parent loader store writes are visible to child
 * loaders — mirroring the React path. This helper itself does NOT open a store
 * scope. */
export async function runNativeChainLoaders(
  chain: Route[],
  ctx: NativeLoaderCtx,
): Promise<NativeChainResult> {
  let merged: Record<string, unknown> = {}
  for (const node of chain) {
    if (!node.loader) continue
    // `as never` bypasses per-route Params narrowing — NativeLoaderCtx is the
    // default-instantiated loader ctx shape ({ params, path, req }).
    const result = await node.loader(ctx as never)
    if (isNativeVerdict(result)) {
      return { verdict: result }
    }
    if (result && typeof result === 'object') {
      merged = { ...merged, ...(result as Record<string, unknown>) }
    }
  }
  return { data: merged }
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
  /** Relative path segment (matchit syntax). Empty string `''` = layout-only
   * (this node contributes nothing to the path; children attach to ancestors).
   * Mutually exclusive with `index: true`. */
  path?: string
  /** Index route — matches the parent path exactly. Must be a leaf (no
   * `children`, no `path`). Mutually exclusive with `path`. */
  index?: boolean
  /** TypeScript can't infer per-entry generics inside a `defineRoutes([...])`
   * literal, so the array would force every Component to accept the default
   * `RouteContext<Record<string, string>, unknown>` shape — components that
   * narrow `Params` / `Data` would fail to type-check. Keep the field
   * permissive here; each component self-declares its expected props. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Component?: ComponentType<any>
  /** Optional async function that runs in the worker before rendering. Its
   * return value becomes the component's `data` prop. Exceptions are caught
   * by `errorBoundary` if declared (inherited from closest ancestor). */
  loader?: (ctx: { params: Params; path: string; req: BrustRequest }) => Promise<Data>
  /** Optional component invoked when Component or loader throws. Inherited
   * by descendants when they don't define their own. */
  errorBoundary?: ComponentType<ErrorBoundaryProps>
  /** Opt-in cache. Cache config from the leaf only — parent's cache is
   * ignored when the route is reached as part of a chain. */
  cache?: RouteCacheConfig
  /** Opt-in SSG behavior for dynamic-param routes (`/blog/{slug}`). Only
   * consulted by `brust build --ssg`. */
  ssg?: RouteSsgConfig
  /** Per-route middleware chain. Runs in declaration order; concatenated
   * with parent middlewares (parent runs before child). Cache lookup
   * still happens BEFORE any middleware (existing rule). */
  middleware?: Middleware[]
  /** Nested children. Each child's path is composed with this node's path
   * via `joinPath` (see flattenRoutes). */
  children?: Route[]
  /** When set, this route streams a text/event-stream response. Cannot
   * coexist with Component, loader, or children (validated at defineRoutes
   * time). The framework auto-sends Content-Type, Cache-Control,
   * X-Accel-Buffering, plus a `: ping\n\n` heartbeat every 15s (opt-out
   * via sseOptions). The author returns ReadableStream<Uint8Array | string>;
   * string chunks are UTF-8 encoded. Listen on req.signal for disconnect. */
  sse?: (
    req: BrustRequest,
  ) => ReadableStream<Uint8Array | string> | Promise<ReadableStream<Uint8Array | string>>
  sseOptions?: {
    /** Auto-emit `: ping\n\n` every N ms. Default 15000. Set 0 to disable. */
    heartbeatMs?: number
  }
  /** When set, this route accepts WebSocket upgrades. Cannot coexist
   * with Component, loader, sse, or children (validated at defineRoutes
   * time). The factory is invoked lazily by the WS dispatch path and
   * cached per worker. The handler module may export `WsHandlers`
   * directly OR as a `default` (the common `() => import('./ws-foo')`
   * pattern returns a module namespace `{ default: WsHandlers }`);
   * `handleWsConn` unwraps `.default` defensively at call time. */
  websocket?: () => Promise<WsHandlers | { default: WsHandlers }>
  wsOptions?: {
    /** Server-initiated ping interval in ms. Default 30000. Set 0 to disable.
     * Pong timeout = 2× pingMs; conn closes with code 1011 if no pong by then. */
    pingMs?: number
    /** Max message size in bytes. Default 1 048 576 (1 MB). Larger frames
     * close the conn with 1009 (Message Too Big). */
    maxMessageBytes?: number
    /** Subprotocols the route supports (Sec-WebSocket-Protocol). Client's
     * requested list is intersected with this; first match (in this declared
     * order) wins and is reflected in Sec-WebSocket-Protocol response. */
    subprotocols?: string[]
  }
  /** Sub-project J — render this route via the native (jinja) engine, not React.
   * `Component` is REQUIRED (the JSX file is the source jsx-rustc compiles
   * into `.brust/jinja/<Component.name>.jinja`). Loader-friendly: the loader's
   * return value becomes the template context. */
  native?: boolean
}

/** Internal post-flatten representation. Each FlatRoute is a single leaf or
 * index route in the user's nested tree. Indexed by Rust's route_id (array
 * position). Consumed by `makeRenderer` and structurally compatible with
 * `brust.registerRoutes` (reads only `fullPath` and `cache`). */
export interface FlatRoute {
  /** Full path Rust matches against. Composed from the chain via joinPath. */
  fullPath: string
  /** Chain of Route nodes from root to leaf, inclusive. Renderer walks
   * this top-down. */
  chain: Route[]
  /** Concatenated middleware from root → leaf. composeChain wraps right-to-left,
   * so the first element here becomes the outermost wrap (runs first). */
  middleware: Middleware[]
  /** Closest errorBoundary in the chain (leaf wins; falls back up the chain). */
  errorBoundary?: ComponentType<ErrorBoundaryProps>
  /** Cache from the leaf only — no parent inheritance. */
  cache?: RouteCacheConfig
  /** Sub-project J — Component.name when leaf had `native: true`. Captured
   * at flatten time (build-time AST identifier), so minifier-safe. */
  nativeTemplate?: string
  /** Catch-all (`{ path: '*' }`) marker. When true this FlatRoute is a
   * "not found" fallback: it stays in the array at its natural index (route_id
   * stable) but install SKIPS the matchit insert for it — it only renders when
   * matchit returns NoMatch under `notFoundPrefix`. NEVER remove a flagged
   * entry from the flat array (that would shift every later route_id). */
  notFound?: boolean
  /** Parent layout's path prefix this catch-all covers. Root catch-all → `''`
   * (matches everything as last resort). Longest segment-prefix wins at match
   * time. Never contains `*` (it's the parent prefix, not the catch-all path). */
  notFoundPrefix?: string
}

/** Compose a child's relative path onto a parent's base path.
 *  - `rel === ''` (layout-only child) → returns `base` unchanged
 *  - `rel` starts with `/` (absolute) → returns `rel` (only valid when base === '';
 *    flattenRoutes rejects this case otherwise)
 *  - otherwise → strip any trailing `/` from base, append `/${rel}` */
export function joinPath(base: string, rel: string): string {
  if (rel === '') return base
  if (rel.startsWith('/')) return rel
  const trimmedBase = base.endsWith('/') ? base.slice(0, -1) : base
  return `${trimmedBase}/${rel}`
}

/** Validate a Route node's structural invariants in the context of its
 * parent's basePath. Throws with a useful message at module top-level —
 * route bugs fail loudly before brust.serve binds. */
function validateRoute(r: Route, basePath: string): void {
  if (r.index === true && r.path !== undefined) {
    throw new Error(`route under "${basePath}": cannot set both index and path`)
  }
  if (r.index === true && r.children && r.children.length > 0) {
    throw new Error(`route under "${basePath}": index route cannot have children`)
  }
  if (!r.index && r.path === undefined && !(r.children && r.children.length > 0)) {
    throw new Error(`route under "${basePath}": must have path, index, or children`)
  }
  if (r.path?.startsWith('/') && basePath !== '') {
    // Absolute children under a non-empty parent are a footgun (the child
    // escapes the parent's URL space). Only allowed when the parent is
    // layout-only (basePath === '').
    throw new Error(
      `route under "${basePath}": absolute child path "${r.path}" must be under a pathless ('') parent`,
    )
  }
  if (r.native === true) {
    const where = r.path ?? '(no path)'
    if (r.Component === undefined) {
      throw new Error(`Route ${where}: 'native: true' requires 'Component'`)
    }
    if (!r.Component.name || r.Component.name.length === 0) {
      throw new Error(
        `Route ${where}: 'native: true' Component must be a named function (got anonymous)`,
      )
    }
    if (r.sse !== undefined) {
      throw new Error(`Route ${where}: 'native: true' cannot coexist with 'sse'`)
    }
    if (r.websocket !== undefined) {
      throw new Error(`Route ${where}: 'native: true' cannot coexist with 'websocket'`)
    }
    // T2 — `native: true` MAY have children, but only if the ENTIRE subtree is
    // also native. The build synthesizes a per-leaf wrapper that composes the
    // whole route chain into one native template; a non-native node anywhere in
    // that chain can't be inlined (it would render via React, breaking native).
    if (r.children !== undefined) {
      assertNativeSubtree(r.children, where)
    }
    // `cache` is now allowed on native routes — they are the primary L1
    // (zero-Bun) target. loader + middleware are EXPLICITLY allowed.
  }
  if (r.sse) {
    const where = r.path ?? '(no path)'
    if (r.Component !== undefined) {
      throw new Error(`Route ${where}: 'sse' cannot coexist with 'Component'`)
    }
    if (r.loader !== undefined) {
      throw new Error(`Route ${where}: 'sse' cannot coexist with 'loader'`)
    }
    if (r.children !== undefined) {
      throw new Error(`Route ${where}: 'sse' cannot have nested children`)
    }
  }
  if (r.websocket) {
    const where = r.path ?? '(no path)'
    if (r.Component !== undefined) {
      throw new Error(`Route ${where}: 'websocket' cannot coexist with 'Component'`)
    }
    if (r.loader !== undefined) {
      throw new Error(`Route ${where}: 'websocket' cannot coexist with 'loader'`)
    }
    if (r.sse !== undefined) {
      throw new Error(`Route ${where}: 'websocket' cannot coexist with 'sse'`)
    }
    if (r.children !== undefined) {
      throw new Error(`Route ${where}: 'websocket' cannot have nested children`)
    }
  }
  // L2 (cache.key) is only reachable via a truthy `bypass`. A key with no
  // bypass is dead config — warn so it isn't silently ignored.
  if (r.cache?.key && r.cache.bypass === undefined) {
    const where = r.path ?? '(no path)'
    console.warn(
      `[brust] route ${where}: cache.key has no cache.bypass — L2 is unreachable (bypass never routes to it)`,
    )
  }
}

/** T2 — recursively assert every node in a native subtree is also `native: true`.
 * A native chain is composed into one native template at build time, so a
 * non-native node anywhere in the subtree would have to render via React,
 * breaking the native fast path. */
function assertNativeSubtree(children: Route[], where: string): void {
  for (const child of children) {
    if (child.native !== true) {
      // Name the offending CHILD, not the native parent — `where` is the parent.
      throw new Error(
        `native route cannot mix native and non-native components in one chain (offending child: ${child.path ?? child.Component?.name ?? '(no path)'}, under: ${where})`,
      )
    }
    if (child.children !== undefined) {
      assertNativeSubtree(child.children, child.path ?? where)
    }
  }
}

/** Walk the nested route tree, emitting one FlatRoute per leaf or index node.
 * Composes paths, middleware, errorBoundary, and cache per the rules in
 * the design spec (S3). */
export function flattenRoutes(routes: Route[]): FlatRoute[] {
  const out: FlatRoute[] = []
  // Tracks `notFoundPrefix` values already claimed by a catch-all so a second
  // catch-all under the same prefix throws instead of silently shadowing.
  const seenNotFoundPrefixes = new Set<string>()
  walkRoutes(routes, [], '', out, seenNotFoundPrefixes)
  return out
}

function walkRoutes(
  routes: Route[],
  parentChain: Route[],
  basePath: string,
  out: FlatRoute[],
  seenNotFoundPrefixes: Set<string>,
): void {
  for (const r of routes) {
    validateRoute(r, basePath)
    const chain = [...parentChain, r]

    if (r.index === true) {
      out.push(makeFlat(chain, basePath))
      continue
    }

    // Catch-all (`{ path: '*' }`) — a "not found" fallback for the `basePath`
    // subtree. It is a LEAF (no children/index) and is KEPT in the flat array
    // at its natural index (route_id stable) flagged `notFound`. Its fullPath
    // is set to the parent prefix (never a `*` matchit pattern) so a later
    // install step can skip the matchit insert and rely on the flag.
    if (r.path === '*') {
      if (r.children && r.children.length > 0) {
        throw new Error(`catch-all route "*" must be a leaf (no children) under "${basePath}"`)
      }
      // (index is already mutually exclusive with path via validateRoute.)
      const prefix = basePath
      if (seenNotFoundPrefixes.has(prefix)) {
        throw new Error(
          `duplicate catch-all route "*": only one catch-all allowed per prefix "${prefix}"`,
        )
      }
      seenNotFoundPrefixes.add(prefix)
      const flat = makeFlat(chain, prefix)
      flat.notFound = true
      flat.notFoundPrefix = prefix
      out.push(flat)
      continue
    }

    const ownPath = r.path ?? ''
    const myPath = joinPath(basePath, ownPath)

    if (r.children && r.children.length > 0) {
      walkRoutes(r.children, chain, myPath, out, seenNotFoundPrefixes)
    } else {
      // Leaf with a path (validated above).
      out.push(makeFlat(chain, myPath))
    }
  }
}

function makeFlat(chain: Route[], fullPath: string): FlatRoute {
  const middleware: Middleware[] = []
  for (const r of chain) {
    if (r.middleware) middleware.push(...r.middleware)
  }
  let errorBoundary: ComponentType<ErrorBoundaryProps> | undefined
  for (const r of chain) {
    if (r.errorBoundary) errorBoundary = r.errorBoundary
  }
  const leaf = chain[chain.length - 1]
  const cache = leaf.cache
  // T2 — a native leaf demands an all-native chain (the build composes the
  // whole chain into one native template). Reject a native leaf reached through
  // a non-native ancestor. NOTE: this is the PRIMARY (not redundant) guard for the
  // non-native-parent → native-child direction — `assertNativeSubtree` only runs
  // from a native PARENT (validateRoute's `if (r.native)` block), so a non-native
  // parent never triggers it; this check is what catches that case.
  if (leaf.native === true && chain.some((node) => node.native !== true)) {
    throw new Error(
      `native route cannot mix native and non-native components in one chain (route: ${leaf.path ?? fullPath})`,
    )
  }
  const nativeTemplate = leaf.native === true && leaf.Component ? leaf.Component.name : undefined
  return { fullPath, chain, middleware, errorBoundary, cache, nativeTemplate }
}

/** Internal React context that carries the next-deeper rendered element to
 * the parent's <Outlet />. Default `null` means "no child to render" —
 * `<Outlet />` from a leaf route or a flat route renders nothing. */
export const OutletContext = createContext<ReactNode>(null)

/** Renders the matched child route inside a parent layout. Read via
 * React context; falls back to null at the leaf or in a flat (non-nested)
 * route. Use inside a parent Component:
 *
 *     function AdminLayout() {
 *       return <div><nav>…</nav><main><Outlet /></main></div>
 *     }
 */
export function Outlet(): ReactNode {
  return useContext(OutletContext)
}

/** Process the user's nested route tree into a flat array for the renderer
 * and Rust route table. Each leaf/index node becomes one FlatRoute. Indices
 * are stable across worker reloads (= array position), matching Rust's
 * route_id semantics. */
export function defineRoutes(routes: Route[]): FlatRoute[] {
  return flattenRoutes(routes)
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
      /** Set by Rust when the route's `cache.bypass` matched — routes this
       * request to the L2 programmatic cache (worker `cache.key`). */
      bypassed?: boolean
    }
  | {
      kind: 'navigation'
      route_id: number
      path: string
      params: Record<string, string>
      req: BrustRequest
    }
  | {
      kind: 'action'
      action_id: string
      /** Request's Content-Type, whitespace-trimmed (case preserved by Rust;
       * the dispatch points below lowercase defensively). '' means the header
       * was missing. */
      content_type: string
      /** UTF-8 text body — present for application/json and
       * application/x-www-form-urlencoded. Mutually exclusive with body_b64. */
      body_text?: string
      /** Base64-encoded binary body — present for multipart/form-data.
       * JS decodes via Buffer.from(s, 'base64') before parsing. */
      body_b64?: string
      /** Path params extracted by the Rust router (e.g. {id} → "abc"). */
      params?: Record<string, string>
      req: BrustRequest
    }
  | {
      kind: 'mcp'
      body_text: string
      req: BrustRequest
    }
  | {
      kind: 'sse'
      conn_id: bigint
      req: BrustRequest
    }
  | {
      kind: 'ws'
      conn_id: bigint
      client_subprotocols: string[]
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
   * Both the main process and each worker call `brust.scanActions(...)` at
   * module top-level and pass the resulting array here — the wire keys (ids)
   * and the handler functions (fn) must agree across both ends. */
  actions?: EndpointDef[]
  /** MCP server instance — built once per worker at module top-level. */
  mcp?: import('./mcp/server.ts').McpServer
  /** Render slots per worker. The `view` SAB is partitioned into this many
   * disjoint sub-views; each render is dispatched with a `slot` index and
   * operates on `view.subarray(slot*sub, slot*sub+sub)`. Default 1 (the whole
   * view → byte-identical to the pre-multi-slot path). */
  slots?: number
}

/** May a framed single-chunk payload (`[meta_len: u16 BE][meta JSON][body]`)
 * enter the L2 page cache? Only a plain 200 without Set-Cookie. The status
 * gate is load-bearing: a jinja render failure comes back as a framed 500
 * through the SAME napiRenderJinja success return as a real render, so without
 * it one flaky render would poison the L2 key for its full TTL. A Set-Cookie
 * response is per-client (a cached one would leak a session). Short/truncated/
 * malformed payloads → NOT cacheable (fail closed). */
function payloadCacheable(payload: Uint8Array): boolean {
  if (payload.length < 2) return false
  const metaLen = (payload[0] << 8) | payload[1]
  if (payload.length < 2 + metaLen) return false
  try {
    const meta = JSON.parse(new TextDecoder().decode(payload.subarray(2, 2 + metaLen)))
    if (meta?.status !== 200) return false
    const headers = (meta?.headers ?? {}) as Record<string, unknown>
    return !Object.keys(headers).some((h) => h.toLowerCase() === 'set-cookie')
  } catch {
    return false
  }
}

// Return a copy of a framed `[meta_len:u16 BE][meta JSON][body]` payload with
// `X-Brust-Cache: HIT` added to the meta headers — stamped on an L2 replay so a
// cache hit is observable on the wire (mirrors the L1 hit header). On any parse
// failure the original payload is returned unchanged (never corrupt a response).
function withCacheHitHeader(payload: Uint8Array): Uint8Array {
  if (payload.length < 2) return payload
  const metaLen = (payload[0] << 8) | payload[1]
  if (payload.length < 2 + metaLen) return payload
  try {
    const meta = JSON.parse(new TextDecoder().decode(payload.subarray(2, 2 + metaLen)))
    meta.headers = { ...(meta.headers ?? {}), 'X-Brust-Cache': 'HIT' }
    const metaBytes = new TextEncoder().encode(JSON.stringify(meta))
    const body = payload.subarray(2 + metaLen)
    const out = new Uint8Array(2 + metaBytes.length + body.length)
    out[0] = (metaBytes.length >> 8) & 0xff
    out[1] = metaBytes.length & 0xff
    out.set(metaBytes, 2)
    out.set(body, 2 + metaBytes.length)
    return out
  } catch {
    return payload
  }
}

export function makeRenderer(
  routes: FlatRoute[],
  view: Uint8Array,
  opts: MakeRendererOptions = {},
): (envelopeJson: string, slot?: number) => Promise<number> {
  const encoder = new TextEncoder()
  const byRouteId = new Map<number, FlatRoute>()
  routes.forEach((r, i) => {
    byRouteId.set(i, r)
  })
  const byActionId = new Map<string, EndpointDef>()
  opts.actions?.forEach((e, i) => {
    byActionId.set(String(i), e)
  })

  // Slot count: the SAB is partitioned into `slots` disjoint sub-views. At
  // slots=1 the sub-view is the whole buffer (byte-identical to before).
  const slots = Math.max(1, opts.slots ?? 1)
  const sub = Math.floor(view.length / slots)

  // napi shim for the chunk channel. The sabBytes arg is ignored by the
  // native fn (Rust reads from the pre-registered BufPtr, offset by slot) —
  // the call sites still pass it so renderBranchStreaming can be unit-tested
  // against a mock that captures the bytes. The `slot` arg selects the SAB
  // sub-region Rust reads from.
  const napi = {
    renderChunk: async (
      workerId: bigint,
      slot: number,
      len: number,
      _sabBytes: Uint8Array,
    ): Promise<void> => {
      await (native as any).napiRenderChunk(Number(workerId), slot, len)
    },
    renderChunkFinal: async (
      workerId: bigint,
      slot: number,
      len: number,
      _sabBytes: Uint8Array,
    ): Promise<void> => {
      await (native as any).napiRenderChunkFinal(Number(workerId), slot, len)
    },
  }

  return async (envelopeJson: string, slot = 0): Promise<number> => {
    // The disjoint SAB sub-view this render owns. At slots=1, slotView === the
    // whole view (offset 0, full length) so the K=1 path is byte-identical.
    // The request always arrives as an INLINE JSON string (SAB-request is closed
    // — see the dispatch module doc); the SAB is used only for the RESPONSE.
    const slotView = slots === 1 ? view : view.subarray(slot * sub, slot * sub + sub)
    const call = JSON.parse(envelopeJson) as RouteCall
    const wid = opts.getWorkerId?.() ?? 0
    const workerId = BigInt(wid)

    if (call.kind === 'render') {
      const flat = byRouteId.get(call.route_id)
      if (!flat) {
        console.error(`[brust] unknown route_id=${call.route_id} for path=${call.path}`)
        await emitSingleChunkResponse(
          slotView,
          napi,
          workerId,
          encoder,
          {
            status: 404,
            contentType: 'text/plain; charset=utf-8',
            body: 'not found',
          },
          slot,
        )
        return 0
      }
      // Inject the permanently-unaborted signal — non-SSE routes don't
      // have a per-conn AbortController. Middleware/loaders/components
      // can still read req.signal.aborted (always false).
      call.req.signal = NEVER_ABORTS

      // Run the middleware chain against a streaming-marker terminal.
      // Middleware that short-circuits (returns without calling next())
      // wins as a plain single-chunk response. Middleware that calls next()
      // gets the marker back and can wrap/mutate `headers` and `status`
      // before we hand control to renderBranchStreaming.
      const STREAM_MARKER: unique symbol = Symbol.for('brust.streamRender')
      type StreamMarkerResponse = RouteResponse & { _brustStream?: typeof STREAM_MARKER }
      const streamTerminal: () => Promise<StreamMarkerResponse> = async () => ({
        status: 200,
        body: '',
        contentType: 'text/html; charset=utf-8',
        _brustStream: STREAM_MARKER,
      })
      const chain = composeChain(call.req, flat.middleware, streamTerminal)

      let verdict: StreamMarkerResponse
      try {
        verdict = (await chain()) as StreamMarkerResponse
      } catch (err) {
        console.error(`[brust] middleware/render uncaught:`, err)
        // FAST LANE: single-chunk error. Works for both React (big dispatch
        // reads the SAB via its fast-lane arm) and native routes (which take
        // the channel-free dispatch_single_chunk).
        return packSingleChunkResponse(slotView, encoder, {
          status: 500,
          contentType: 'text/html; charset=utf-8',
          body: 'internal error',
        })
      }

      if (verdict._brustStream !== STREAM_MARKER) {
        // Middleware short-circuited with a concrete response. FAST LANE —
        // single-chunk; same dual-dispatch safety as the error path above.
        return packSingleChunkResponse(slotView, encoder, {
          status: verdict.status,
          contentType: verdict.contentType ?? 'text/html; charset=utf-8',
          body: verdict.body,
          headers: verdict.headers,
        })
      }

      // L2 programmatic page cache (Task 10). Only on a bypassed request whose
      // route declares a `cache.key` function. Runs AFTER middleware (which may
      // set cookies / auth context the key depends on) and BEFORE render.
      //   HIT  → write the cached framed payload into the SAB slot, return its
      //          length — the exact fast-lane shape Rust reads from a native
      //          render, so the loader+render are skipped entirely.
      //   MISS → render normally, then capture slotView[0..len] and pageCacheSet.
      // Streaming/Suspense responses never reach the `len > 0` fast-lane return
      // below (renderBranchStreaming returns 0), so they are never L2-cached.
      // L2 capture/replay rides the NATIVE SAB fast-lane (a framed payload in
      // slotView + a length return). React routes emit via the chunk channel and
      // return 0, so engaging L2 there would return a non-zero length into the
      // streaming path = protocol corruption. Gate L2 to native routes; a React
      // route with `bypass` still skips L1 and renders fresh (no L2).
      const cc = flat.cache
      const wantL2 =
        call.bypassed === true && typeof cc?.key === 'function' && flat.nativeTemplate !== undefined
      let l2Key: CacheKeyResult | undefined
      if (wantL2 && cc) {
        const url = new URL(call.req.url, 'http://internal') // req.url is a path+query
        try {
          l2Key = await cc.key!({ req: call.req, url, params: call.params ?? {} })
        } catch (err) {
          // A throwing/rejecting key() must not crash the worker — fall back to
          // a fresh render. l2Key stays undefined → replay skipped, store no-op.
          console.error('[brust] cache.key threw; bypassing L2 (rendering fresh):', err)
        }
        if (l2Key) {
          const cached = (native as any).pageCacheGet?.(l2Key.key) as Buffer | null | undefined
          if (cached && cached.length > 0) {
            // REPLAY — stamp the framed meta with X-Brust-Cache: HIT, then write
            // it into the slot and return its length (fast lane). Prefer the
            // stamped payload; if the extra header tips it past the slot, fall
            // back to the verbatim bytes; only a too-large verbatim payload
            // falls through to a fresh render (never serve truncated bytes).
            const stamped = withCacheHitHeader(cached)
            const out =
              stamped.length <= slotView.length
                ? stamped
                : cached.length <= slotView.length
                  ? cached
                  : null
            if (out) {
              slotView.set(out, 0)
              return out.length
            }
          }
        }
      }
      // Capture-and-store on an L2 miss. Wraps the native success returns; a
      // no-op when not bypassed or no key. Only single-chunk (len > 0) bytes
      // that fit the slot and carry no Set-Cookie are stored.
      const maybeStoreL2 = (len: number): number => {
        if (wantL2 && cc && l2Key && len > 0 && len <= slotView.length) {
          const payload = slotView.subarray(0, len).slice() // copy out of the SAB
          if (payloadCacheable(payload)) {
            const ttlSec = l2Key.ttl ?? cc.key_ttl_seconds ?? cc.ttl_seconds
            try {
              ;(native as any).pageCacheSet?.(
                l2Key.key,
                l2Key.tags ?? [],
                Math.round(ttlSec * 1000),
                payload,
              )
            } catch (err) {
              console.error('[brust] pageCacheSet failed (response served, not cached):', err)
            }
          }
        }
        return len
      }

      // Sub-project J — native: true branch. Runs the leaf's loader (if any),
      // JSON-encodes the result into the SAB, then invokes napiRenderJinja
      // which performs the minijinja render Rust-side and emits a 200 chunk
      // through the same render-chunk channel as the React path.
      //
      // KNOWN LIMITATION: middleware can short-circuit by returning a
      // RouteResponse without next() — that's the verdict._brustStream / status
      // path above and works for native routes. But middleware that calls
      // next() then mutates status/headers (e.g. adds Cache-Control) is NOT
      // forwarded; napi_render_jinja hardcodes status: 200 and empty headers.
      // Spec S4 doesn't define post-next() mutation semantics for native;
      // deferred to v2.x. If your middleware needs to mutate, use a React
      // route for now.
      if (flat.nativeTemplate !== undefined) {
        let data: Record<string, unknown>
        const ctx = { params: call.params, path: call.path, req: call.req }
        let chainResult: NativeChainResult
        let storeSnapshot: Record<string, Record<string, unknown>> | null = null
        try {
          // Run the WHOLE route chain's loaders top-down (parent → leaf) and
          // merge into ONE flat context (child keys win), mirroring the React
          // chain-loader path. Wrap the entire loop in a SINGLE per-request
          // store scope so a parent loader's defineStore writes are visible to
          // child loaders (one Map per request — NOT one per loader). B7: the
          // store snapshot IS collected here, inside the request-store scope and
          // AFTER the loaders run (the only point native store writes happen —
          // the render is Rust-side and touches no store), feeding the
          // document-shell `{{ __brust_store__ }}` slot below.
          chainResult = await runInRequestContext(call.req?.cookies ?? {}, async () => {
            const r = await runNativeChainLoaders(flat.chain, ctx)
            storeSnapshot = collectSnapshot()
            return r
          })
        } catch (err) {
          console.error(`[brust] loader failed for native route ${flat.fullPath}:`, err)
          // FAST LANE: native routes take dispatch_single_chunk (no chunk
          // channel), so every native fallback MUST pack + return a length.
          return packSingleChunkResponse(slotView, encoder, {
            status: 500,
            contentType: 'text/html; charset=utf-8',
            body: 'internal error',
          })
        }
        let renderStatus: number | undefined
        if ('verdict' in chainResult) {
          // First verdict wins (top-down). Remaining loaders already skipped.
          const verdict = chainResult.verdict
          if (!verdict.render) {
            // redirect — no template render; fast-lane packed response with Location.
            return packSingleChunkResponse(slotView, encoder, {
              status: verdict.status,
              contentType: 'text/html; charset=utf-8',
              body: '',
              headers: verdict.headers,
            })
          }
          // notFound — render the route's own template, but with the verdict's status.
          renderStatus = verdict.status
          data = (verdict.data ?? {}) as Record<string, unknown>
        } else {
          data = chainResult.data
        }
        // B7 — native store-snapshot SSR. Fill the framework-owned
        // `{{ __brust_store__ | safe }}` slot (emitted into every native
        // full-document <head>) with the defineStore SSR snapshot collected
        // inside the request-store scope above. buildStoreScripts(null) === '',
        // so the key is always a string and both render sub-paths (the
        // island/component JSON.parse path and the no-island encode path)
        // inherit it for free.
        if (data && typeof data === 'object') {
          // `__brust_store__` is a framework-reserved render-context key. A user
          // loader returning it would be silently overwritten here; dev-warn so
          // the collision isn't invisible (mirrors the Set-Cookie warning below).
          if (process.env.BRUST_DEV === '1' && '__brust_store__' in data) {
            console.warn(
              `[brust] native loader for "${flat.nativeTemplate}" returned a reserved "__brust_store__" key — overwritten by the store snapshot`,
            )
          }
          ;(data as Record<string, unknown>).__brust_store__ = buildStoreScripts(storeSnapshot)
          // Component-CSS SSR. Fill the framework-owned
          // `{{ __brust_component_css__ | safe }}` head slot with the route's
          // component-CSS chunk <link>s (from the component-CSS manifest, seeded
          // per-route in the worker). Empty string when the route imports no
          // .module.css / co-located .css, so the slot always resolves.
          if (process.env.BRUST_DEV === '1' && '__brust_component_css__' in data) {
            console.warn(
              `[brust] native loader for "${flat.nativeTemplate}" returned a reserved "__brust_component_css__" key — overwritten by the component-CSS links`,
            )
          }
          ;(data as Record<string, unknown>).__brust_component_css__ = getCssHrefsForRoute(
            flat.fullPath,
          )
            .map((href) => `<link rel="stylesheet" href="${href}"/>`)
            .join('')
        }
        const json = JSON.stringify(data)
        // napiRenderJinja has no headers param — any Set-Cookie staged by a
        // native loader is dropped on this path. Dev-warn so it's not silent.
        if ((__scope()?.setCookies.length ?? 0) > 0 && process.env.BRUST_DEV === '1') {
          console.warn(
            `[brust] cookies.set in a native loader for "${flat.nativeTemplate}" is dropped — native render has no headers; use a React route to write cookies`,
          )
        }
        // Sub-project J — islands + components. If this template has an enriched
        // islands manifest or a components manifest, merge per-island context vars
        // (island_<id>_props, plus island_<id>_html for ssr entries) and per-component
        // context vars (comp_<id>_html for SSR components) into the loader data before
        // shipping it. Both resolvers are async; run them in parallel via Promise.all.
        const manifest = loadIslandManifest(flat.nativeTemplate)
        const compManifest = loadComponentManifest(flat.nativeTemplate)
        if ((manifest && manifest.length > 0) || (compManifest && compManifest.length > 0)) {
          const rt = JSON.parse(json) as Record<string, unknown>
          const [islandExtra, componentExtra] = await Promise.all([
            manifest && manifest.length > 0
              ? resolveIslandContext(manifest, rt, islandCache)
              : Promise.resolve({} as Record<string, string>),
            compManifest && compManifest.length > 0
              ? resolveComponentContext(
                  compManifest,
                  rt,
                  flat.nativeTemplate,
                  undefined,
                  islandCache,
                )
              : Promise.resolve({} as Record<string, string>),
          ])
          const ctx = { ...rt, ...islandExtra, ...componentExtra }
          const finalBytes = encoder.encode(JSON.stringify(ctx))
          // The original size check guarded the pre-island bytes; the merged
          // context (with island props + component html) can be larger. Re-check on finalBytes.
          if (finalBytes.length > slotView.length) {
            return packSingleChunkResponse(slotView, encoder, {
              status: 413,
              contentType: 'text/plain; charset=utf-8',
              body: 'loader data too large for SAB',
            })
          }
          slotView.set(finalBytes, 0)
          try {
            return maybeStoreL2(
              (native as any).napiRenderJinja(
                Number(workerId),
                slot,
                finalBytes.length,
                flat.nativeTemplate,
                renderStatus,
              ),
            )
          } catch (err) {
            console.error(`[brust] napiRenderJinja failed for "${flat.nativeTemplate}":`, err)
            return packSingleChunkResponse(slotView, encoder, {
              status: 500,
              contentType: 'text/html; charset=utf-8',
              body: 'internal error',
            })
          }
        }
        const dataBytes = encoder.encode(json)
        if (dataBytes.length > slotView.length) {
          return packSingleChunkResponse(slotView, encoder, {
            status: 413,
            contentType: 'text/plain; charset=utf-8',
            body: 'loader data too large for SAB',
          })
        }
        slotView.set(dataBytes, 0)
        try {
          // FAST LANE: napiRenderJinja is a SYNC napi call — renders Rust-side,
          // writes the framed response into the SAB, and returns its length
          // directly (no Promise round-trip). Return it up to the tsfn; Rust's
          // fast-lane arm reads the SAB directly (no chunk channel).
          return maybeStoreL2(
            (native as any).napiRenderJinja(
              Number(workerId),
              slot,
              dataBytes.length,
              flat.nativeTemplate,
              renderStatus,
            ),
          )
        } catch (err) {
          console.error(`[brust] napiRenderJinja failed for "${flat.nativeTemplate}":`, err)
          return packSingleChunkResponse(slotView, encoder, {
            status: 500,
            contentType: 'text/html; charset=utf-8',
            body: 'internal error',
          })
        }
      }

      // Wrap the loader run (inside buildRenderElement) AND the React render in
      // one AsyncLocalStorage store scope so any defineStore read during loaders
      // or render resolves the same per-request instance. Snapshot is collected
      // after loaders (buildRenderElement resolved) — that's where Spec A stores
      // are seeded — and threaded into the render for <script> injection.
      return await runInRequestContext(call.req?.cookies ?? {}, async () => {
        // Computed ONCE and shared by buildRenderElement (leaf swap) and
        // renderBranchStreaming (forceIslands) so the two can never diverge.
        const shellMode = wantsSsgFallbackShell(flat, call)
        let element: ReactNode
        let errorBoundary: ComponentType<{ error: Error }>
        try {
          element = await buildRenderElement(call, flat, opts.getWorkerId, shellMode)
          errorBoundary =
            flat.errorBoundary ??
            (({ error }) => createElement('div', null, `Internal Server Error: ${error.message}`))
        } catch (err) {
          // Setup failure BEFORE renderToPipeableStream — loader throw, params
          // bind throw. Shape matches the legacy "internal error" path so
          // existing integration tests stay green.
          console.error(`[brust] render setup failed:`, err)
          return await emitSingleChunkResponse(
            slotView,
            napi,
            workerId,
            encoder,
            {
              status: 500,
              contentType: 'text/html; charset=utf-8',
              body: 'internal error',
            },
            slot,
          )
        }
        const storeSnapshot = collectSnapshot()
        await renderBranchStreaming({
          element,
          view: slotView,
          slot,
          workerId,
          napi,
          errorBoundary,
          status: verdict.status,
          headers: flushSetCookie(verdict.headers),
          routePath: flat.fullPath,
          storeSnapshot,
          // SSG fallback shells have zero islands on the page but the
          // client-loader runtime still needs the importmap + bootstrap.
          forceIslands: shellMode,
        })
        // renderBranchStreaming wrote via the chunk channel.
        return 0
      })
    }
    if (call.kind === 'navigation') {
      await navigationBranch(call, byRouteId, slotView, encoder, opts.getWorkerId, slot)
      return 0
    }
    if (call.kind === 'action') {
      // FAST LANE: pack the framed response into the SAB and return its length.
      // Rust reads it directly after the Promise settles — no chunk channel.
      const resp = await dispatchAction(call, byActionId)
      return packSingleChunkResponse(slotView, encoder, resp)
    }
    if (call.kind === 'mcp') {
      const resp = await mcpBranchToResponse(call, opts.mcp)
      return await emitSingleChunkResponse(slotView, napi, workerId, encoder, resp, slot)
    }
    if (call.kind === 'sse') {
      try {
        await sseBranch(call, slotView, encoder, routes)
      } catch (err) {
        // Setup-time errors only (BigInt coerce, dynamic import resolve,
        // napi shim build). Once handleSseStream has started streaming,
        // Rust already wrote 200 headers and frames — this 500 is irrelevant.
        console.error('[brust] sseBranch uncaught:', err)
      }
      // SSE bypasses the chunk channel entirely — handleSseStream owns the
      // socket via napiSse* fns. No renderChunk calls here.
      return 0
    }
    if (call.kind === 'ws') {
      try {
        await wsBranch(call, slotView, encoder, routes)
      } catch (err) {
        // Setup-time errors only — same reasoning as sseBranch above.
        console.error('[brust] wsBranch uncaught:', err)
      }
      // WS bypasses the chunk channel entirely — handleWsConn owns the
      // socket via napiWs* fns. No renderChunk calls here.
      return 0
    }
    // Unknown kind — log and 500. Shouldn't happen unless Rust ships
    // something out of band.
    console.error(`[brust] unknown envelope kind in worker:`, (call as { kind?: string }).kind)
    return await emitSingleChunkResponse(
      slotView,
      napi,
      workerId,
      encoder,
      {
        status: 500,
        contentType: 'text/plain; charset=utf-8',
        body: 'invalid envelope kind',
      },
      slot,
    )
  }
}

/** Render a React element to a single HTML string, awaiting all Suspense
 * boundaries via onAllReady. Used by navigationBranch — renderToString
 * would only capture the shell + fallbacks, while renderBranchStreaming
 * is for the streaming render path. */
function renderToAwaitedString(element: ReactNode): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    const sink = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        cb()
      },
    })
    sink.on('finish', () => resolve(Buffer.concat(chunks).toString('utf8')))
    sink.on('error', reject)

    let stream: ReturnType<typeof renderToPipeableStream>
    stream = renderToPipeableStream(element, {
      onAllReady() {
        try {
          stream.pipe(sink)
        } catch (e) {
          reject(e)
        }
      },
      onShellError(err) {
        reject(err)
      },
      onError(err) {
        // Logged at the navigationBranch level; let onAllReady drive completion.
        console.error('[brust] navigation render onError:', err)
      },
    })
  })
}

async function navigationBranch(
  call: Extract<RouteCall, { kind: 'navigation' }>,
  byRouteId: Map<number, FlatRoute>,
  view: Uint8Array,
  encoder: TextEncoder,
  getWorkerId: (() => number | null) | undefined,
  slot = 0,
): Promise<void> {
  const workerId = BigInt(getWorkerId?.() ?? 0)
  const napi = {
    renderChunk: async (wid: bigint, s: number, len: number, _view: Uint8Array): Promise<void> => {
      await (native as any).napiRenderChunk(Number(wid), s, len)
    },
    renderChunkFinal: async (
      wid: bigint,
      s: number,
      len: number,
      _view: Uint8Array,
    ): Promise<void> => {
      await (native as any).napiRenderChunkFinal(Number(wid), s, len)
    },
  }

  const flat = byRouteId.get(call.route_id)
  if (!flat) {
    await emitSingleChunkResponse(
      view,
      napi,
      workerId,
      encoder,
      {
        status: 404,
        contentType: 'application/json; charset=utf-8',
        body: '{"error":"not found"}',
      },
      slot,
    )
    return
  }

  // Run the middleware chain before rendering — mirrors the render branch's
  // middleware pattern. A short-circuit verdict is emitted as the navigation
  // response (client treats any non-2xx as a fallback trigger → full reload).
  const NAV_MARKER: unique symbol = Symbol.for('brust.streamRender')
  type NavMarkerResponse = RouteResponse & { _brustStream?: typeof NAV_MARKER }
  const navTerminal: () => Promise<NavMarkerResponse> = async () => ({
    status: 200,
    body: '',
    contentType: 'application/json; charset=utf-8',
    _brustStream: NAV_MARKER,
  })

  // navigationBranch receives a 'navigation' call, but composeChain only
  // needs req + middleware — cast to satisfy the type.
  const navChain = composeChain(
    (call as unknown as Extract<RouteCall, { kind: 'render' }>).req,
    flat.middleware,
    navTerminal,
  )

  let navVerdict: NavMarkerResponse
  try {
    navVerdict = (await navChain()) as NavMarkerResponse
  } catch (err) {
    console.error('[brust] navigation middleware threw:', err)
    await emitSingleChunkResponse(
      view,
      napi,
      workerId,
      encoder,
      {
        status: 500,
        contentType: 'application/json; charset=utf-8',
        body: '{"error":"middleware threw"}',
      },
      slot,
    )
    return
  }

  if (navVerdict._brustStream !== NAV_MARKER) {
    // Middleware short-circuited — emit the verdict. Client's non-2xx check
    // triggers the full-reload fallback so the user hits the real route and
    // sees the middleware's challenge page.
    await emitSingleChunkResponse(
      view,
      napi,
      workerId,
      encoder,
      {
        status: navVerdict.status,
        contentType: navVerdict.contentType ?? 'application/json; charset=utf-8',
        body: navVerdict.body,
        headers: navVerdict.headers,
      },
      slot,
    )
    return
  }

  try {
    // Native (jinja) routes have no React tree, so we can't renderToString them.
    // Render the template Rust-side (same path as a full document load) and use
    // its HTML; React routes keep the renderToAwaitedString path below. Without
    // this branch, a SPA navigation to a native route React-renders a component
    // whose loader fields arrive undefined → throws → 500 → full-reload fallback
    // on every internal link.
    let fullHtml: string
    // React nav: snapshot of stores seeded during loader+render, shipped in the
    // nav payload so the client can apply it to its live stores. Native nav
    // collects no snapshot (Spec B owns native store delivery).
    let store: Record<string, Record<string, unknown>> | null = null
    // Set-Cookie staged by a React nav loader, flushed onto the nav response
    // below. The request scope is opened per-path (inside runInRequestContext),
    // so capture the flushed headers inside that scope — the emit runs after the
    // scope has closed. Native nav (renderNativeRouteToHtml) opens its own scope
    // with no headers param, so staged cookies are dropped there (same as the
    // full-document native render path).
    let navHeaders: Record<string, string> | undefined
    if (flat.nativeTemplate !== undefined) {
      fullHtml = await renderNativeRouteToHtml(call, flat, view, encoder, workerId, slot)
    } else {
      // Wrap loader run (inside buildRenderElement) + render in one store scope so
      // store reads resolve the per-request instance; collect after render.
      // Shell mode here only swaps the leaf for the marker div — no bootstrap
      // injection is needed in a NAV payload: the payload is swapped into a
      // document that already booted the bootstrap (the navigator IS the
      // bootstrap), and the takeover runtime imports its chunk itself.
      fullHtml = await runInRequestContext(call.req?.cookies ?? {}, async () => {
        const element = await buildRenderElement(
          call as any,
          flat,
          getWorkerId,
          wantsSsgFallbackShell(flat, call as any),
        )
        if (!element) throw new Error('render setup failed')
        // Use renderToPipeableStream + onAllReady so pages with <Suspense> emit
        // their RESOLVED markup, not the fallback. renderToString would only
        // capture the shell — navigating SPA-style to a Suspense-using route
        // would otherwise ship "loading…" and never recover.
        const html = await renderToAwaitedString(element)
        store = collectSnapshot()
        navHeaders = flushSetCookie(undefined)
        return html
      })
    }

    // Extract <main> inner content. If the page didn't render a <main>,
    // ship the full HTML — the client's no-main check will fire its
    // full-reload fallback.
    //
    // Known limitation: the lazy regex truncates at the first </main>, so
    // a page that renders nested <main> elements (invalid per the HTML
    // spec but allowed by React) would lose content after the inner
    // </main>. A future task can replace this with stack-counting
    // extraction or DOMParser if real apps hit it.
    const mainMatch = fullHtml.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
    const innerHtml = mainMatch ? mainMatch[1] : fullHtml

    // Extract <title> text. React 18 inserts <!-- --> markers between
    // adjacent text nodes inside <title>; strip those before serialising.
    const titleMatch = fullHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
    const title = titleMatch ? titleMatch[1].replace(/<!--.*?-->/g, '').trim() : ''

    const body = JSON.stringify({ html: innerHtml, title, store })
    await emitSingleChunkResponse(
      view,
      napi,
      workerId,
      encoder,
      {
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body,
        headers: navHeaders,
      },
      slot,
    )
  } catch (err) {
    console.error('[brust] navigation render failed:', err)
    await emitSingleChunkResponse(
      view,
      napi,
      workerId,
      encoder,
      {
        status: 500,
        contentType: 'application/json; charset=utf-8',
        body: '{"error":"render failed"}',
      },
      slot,
    )
  }
}

/** Render a native (jinja) route to its full HTML document for a SPA navigation.
 *
 * Mirrors the render-branch native path: run the whole route chain's loaders
 * (top-down, merged), merge island /
 * component manifest context, then call the SYNC `napiRenderJinja`, which writes
 * a framed `[meta_len u16 BE][meta JSON][body]` response into the SAB and returns
 * its length. Here — unlike the render branch, which returns that length so Rust
 * streams the SAB straight to the socket — we read the body back out of the SAB
 * and hand it to navigationBranch, which extracts `<main>` + `<title>` from it.
 *
 * Throws on loader failure / oversized data / non-200 render; navigationBranch's
 * catch turns that into a 500 (→ client full-reload fallback). */
async function renderNativeRouteToHtml(
  call: Extract<RouteCall, { kind: 'navigation' }>,
  flat: FlatRoute,
  view: Uint8Array,
  encoder: TextEncoder,
  workerId: bigint,
  slot = 0,
): Promise<string> {
  const templateName = flat.nativeTemplate as string

  // Run the WHOLE route chain's loaders top-down and merge into ONE flat context
  // (child keys win), mirroring the full-render branch. One per-request store
  // scope wraps the entire loop (isolation only — no snapshot / no <script>).
  const chainResult = await runInRequestContext(call.req?.cookies ?? {}, () =>
    runNativeChainLoaders(flat.chain, {
      params: call.params,
      path: call.path,
      req: call.req,
    }),
  )

  if ('verdict' in chainResult) {
    // SPA nav can't emit a redirect/404 in-place; force the client's full-reload
    // fallback so the document path produces the authoritative status.
    throw new Error('native verdict on SPA navigation — falling back to full reload')
  }

  let ctx = chainResult.data
  const manifest = loadIslandManifest(templateName)
  const compManifest = loadComponentManifest(templateName)
  if ((manifest && manifest.length > 0) || (compManifest && compManifest.length > 0)) {
    const [islandExtra, componentExtra] = await Promise.all([
      manifest && manifest.length > 0
        ? resolveIslandContext(manifest, ctx, islandCache)
        : Promise.resolve({} as Record<string, string>),
      compManifest && compManifest.length > 0
        ? resolveComponentContext(compManifest, ctx, templateName, undefined, islandCache)
        : Promise.resolve({} as Record<string, string>),
    ])
    ctx = { ...ctx, ...islandExtra, ...componentExtra }
  }

  const bytes = encoder.encode(JSON.stringify(ctx))
  if (bytes.length > view.length) throw new Error('native loader data too large for SAB')
  view.set(bytes, 0)

  const len = (native as any).napiRenderJinja(
    Number(workerId),
    slot,
    bytes.length,
    templateName,
  ) as number

  // Parse the framed response the SAB now holds: [meta_len u16 BE][meta][body].
  const metaLen = (view[0] << 8) | view[1]
  const decoder = new TextDecoder()
  const meta = JSON.parse(decoder.decode(view.subarray(2, 2 + metaLen))) as { status?: number }
  if (meta.status !== 200) throw new Error(`native render returned status ${meta.status}`)
  return decoder.decode(view.subarray(2 + metaLen, len))
}

/** Param value the SSG build crawler substitutes for every `{param}` when it
 * requests the fallback SHELL of an `ssg.fallback: 'client'` route. */
const SSG_FALLBACK_SENTINEL = '__brust_fallback__'

/** True when this render/navigation call is the SSG build crawler asking for
 * the fallback shell: the leaf declares `ssg.fallback: 'client'`, the route
 * has ≥1 param and EVERY param value is the literal sentinel, AND the request
 * carries `x-brust-ssg: 1` (BrustRequest.headers is a plain lower-cased
 * Record — see the type doc). Live traffic never sends the header, so the
 * sentinel namespace is unreachable in production; a forged header yields a
 * shell that renders LESS than a normal request (leaf loader skipped). */
function wantsSsgFallbackShell(
  flat: FlatRoute,
  call: { params: Record<string, string>; req: BrustRequest },
): boolean {
  const leaf = flat.chain[flat.chain.length - 1]
  if (leaf?.ssg?.fallback !== 'client') return false
  const names = Object.keys(call.params ?? {})
  // Parameterless routes can never be in shell mode — intentional, not a
  // vacuous-truth bug: expandDynamicRoutes already rejects ssg config on
  // routes without {param}, and a no-param route is always fully
  // prerenderable.
  if (names.length === 0) return false
  if (!names.every((name) => call.params[name] === SSG_FALLBACK_SENTINEL)) return false
  return call.req?.headers?.['x-brust-ssg'] === '1'
}

/** Build the React element for a render or navigation call: runs loaders
 * top-down, builds the element bottom-up wrapping in OutletContext.Provider
 * so nested routes receive the deeper element via <Outlet />. The caller
 * (render branch or navigationBranch) is responsible for running the
 * middleware chain BEFORE calling this — this helper assumes middleware
 * has already passed.
 *
 * SSG fallback-shell mode (`wantsSsgFallbackShell`): parent loaders still run
 * (layouts need their data) but the LEAF loader is skipped and the leaf
 * Component is replaced by the marker div the client-loader runtime mounts
 * into. Both the render branch and navigationBranch flow through here, so the
 * shell swap covers full-document AND SPA-navigation payloads.
 *
 * Throws on setup failure (loader throw, etc.). The caller synthesises a 500
 * in that case.
 */
async function buildRenderElement(
  call: Extract<RouteCall, { kind: 'render' }>,
  flat: FlatRoute,
  getWorkerId?: () => number | null,
  // Computed ONCE by the caller (and reused there for forceIslands) so the
  // shell decision and the bootstrap-injection decision can never diverge.
  shellMode = false,
): Promise<ReactNode> {
  call.req.signal = NEVER_ABORTS
  const workerId = getWorkerId ? getWorkerId() : null
  const chainNodes = flat.chain
  const leafIdx = chainNodes.length - 1

  // 1. Run loaders top-down (parent → leaf). Each Component receives ONLY
  //    its own loader's data — no merge, no inheritance. Shell mode skips
  //    the LEAF loader (its data comes from the clientLoader at runtime).
  const datas: unknown[] = new Array(chainNodes.length)
  for (let i = 0; i < chainNodes.length; i++) {
    const r = chainNodes[i]
    datas[i] =
      r.loader && !(shellMode && i === leafIdx)
        ? await r.loader({ params: call.params, path: call.path, req: call.req })
        : undefined
  }

  // 2. Build the React element bottom-up. Each level wraps the deeper level
  //    via <OutletContext.Provider value={renderedChild}>; <Outlet /> in any
  //    parent Component returns that value.
  let element: ReactNode = null
  for (let i = chainNodes.length - 1; i >= 0; i--) {
    const r = chainNodes[i]
    const node =
      shellMode && i === leafIdx
        ? createElement(
            'div',
            {
              'data-brust-fallback-root': '',
              'data-brust-fallback': flat.fullPath,
            },
            r.ssg?.placeholder ? createElement(r.ssg.placeholder) : null,
          )
        : createElement(r.Component!, {
            params: call.params,
            path: call.path,
            data: datas[i],
            workerId,
            req: call.req,
          })
    element = createElement(OutletContext.Provider, { value: element }, node)
  }
  return element
}

/** Pack a framed single-chunk response `[meta_len: u16 BE][meta JSON][body]`
 * into the SAB and return its total byte length — the FAST LANE. The worker
 * resolves its render Promise with this length; Rust reads the framed bytes
 * directly from the SAB after the Promise settles, bypassing the chunk channel
 * (no napiRenderChunk call, no per-chunk ack round-trip). Returns the length so
 * the caller can `return` it up to the tsfn.
 *
 * On SAB overflow, packs a small 500 instead and returns ITS length — the
 * response always fits, so the client never hangs waiting for a body. */
function packSingleChunkResponse(
  view: Uint8Array,
  encoder: TextEncoder,
  resp: {
    status: number
    contentType: string
    body: string | Uint8Array
    headers?: Record<string, string>
  },
): number {
  const bodyBytes = typeof resp.body === 'string' ? encoder.encode(resp.body) : resp.body
  const meta = JSON.stringify({
    status: resp.status,
    contentType: resp.contentType,
    headers: resp.headers ?? {},
    streaming: false,
  })
  const metaBytes = encoder.encode(meta)
  const total = 2 + metaBytes.length + bodyBytes.length
  if (total > view.length) {
    console.error(`[brust] fast-lane response ${total}b exceeds SAB ${view.length}b — emitting 500`)
    const errBody = encoder.encode('response body too large')
    const errMeta = JSON.stringify({
      status: 500,
      contentType: 'text/plain; charset=utf-8',
      headers: {},
      streaming: false,
    })
    const errMetaBytes = encoder.encode(errMeta)
    const errTotal = 2 + errMetaBytes.length + errBody.length
    view[0] = (errMetaBytes.length >> 8) & 0xff
    view[1] = errMetaBytes.length & 0xff
    view.set(errMetaBytes, 2)
    view.set(errBody, 2 + errMetaBytes.length)
    return errTotal
  }
  view[0] = (metaBytes.length >> 8) & 0xff
  view[1] = metaBytes.length & 0xff
  view.set(metaBytes, 2)
  view.set(bodyBytes, 2 + metaBytes.length)
  return total
}

/** Emit a single-chunk response through the chunk channel — wire shape
 * matches what dispatch_to_worker_and_stream_chunks expects (one Bytes
 * chunk with `[meta_len][meta][body]`, then Final). Used by mcp branch
 * and by setup-failure fallbacks in the render branch. Returns 0 (the
 * "used the chunk channel" sentinel) so callers can `return` it up to the
 * tsfn. */
async function emitSingleChunkResponse(
  view: Uint8Array,
  napi: {
    renderChunk: (w: bigint, slot: number, len: number, view: Uint8Array) => Promise<void>
    renderChunkFinal: (w: bigint, slot: number, len: number, view: Uint8Array) => Promise<void>
  },
  workerId: bigint,
  encoder: TextEncoder,
  resp: {
    status: number
    contentType: string
    body: string | Uint8Array
    headers?: Record<string, string>
  },
  slot = 0,
): Promise<number> {
  const bodyBytes = typeof resp.body === 'string' ? encoder.encode(resp.body) : resp.body
  const meta = JSON.stringify({
    status: resp.status,
    contentType: resp.contentType,
    headers: resp.headers ?? {},
    streaming: false,
  })
  const metaBytes = encoder.encode(meta)
  const total = 2 + metaBytes.length + bodyBytes.length
  if (total > view.length) {
    console.error(
      `[brust] single-chunk response ${total}b exceeds SAB ${view.length}b — emitting 500`,
    )
    // Emit a proper 500 plain-text response so the client doesn't hang on
    // TCP timeout waiting for a body that never comes. The fallback body is
    // small enough to always fit in the SAB.
    const errBody = encoder.encode('response body too large')
    const errMeta = JSON.stringify({
      status: 500,
      contentType: 'text/plain; charset=utf-8',
      headers: {},
      streaming: false,
    })
    const errMetaBytes = encoder.encode(errMeta)
    const errTotal = 2 + errMetaBytes.length + errBody.length
    view[0] = (errMetaBytes.length >> 8) & 0xff
    view[1] = errMetaBytes.length & 0xff
    view.set(errMetaBytes, 2)
    view.set(errBody, 2 + errMetaBytes.length)
    await napi.renderChunkFinal(workerId, slot, errTotal, view)
    return 0
  }
  view[0] = (metaBytes.length >> 8) & 0xff
  view[1] = metaBytes.length & 0xff
  view.set(metaBytes, 2)
  view.set(bodyBytes, 2 + metaBytes.length)
  await napi.renderChunkFinal(workerId, slot, total, view)
  return 0
}

/** Plain response object shape returned by action/mcp branches and consumed
 * by `emitSingleChunkResponse`. The branches no longer write to the SAB
 * directly — they hand back a JS-side response and the caller packs +
 * dispatches it through the chunk channel. */
interface BranchResponse {
  status: number
  contentType: string
  body: string | Uint8Array
  headers?: Record<string, string>
}

async function decodeActionBody(
  call: Extract<RouteCall, { kind: 'action' }>,
): Promise<{ ok: true; value: unknown } | { ok: false; status: number; body: string }> {
  const ct = (call.content_type ?? '').toLowerCase()
  // urlencoded → flat object of strings
  if (ct.startsWith('application/x-www-form-urlencoded')) {
    return { ok: true, value: Object.fromEntries(new URLSearchParams(call.body_text ?? '')) }
  }
  // multipart → object of strings + File entries (via Bun's Response.formData)
  if (ct.startsWith('multipart/form-data')) {
    try {
      const bytes = Buffer.from(call.body_b64 ?? '', 'base64')
      const fd = await new Response(bytes, {
        headers: { 'content-type': call.content_type },
      }).formData()
      return { ok: true, value: Object.fromEntries(fd.entries()) }
    } catch (err) {
      return {
        ok: false,
        status: 400,
        body: JSON.stringify({
          error: { message: `invalid multipart body: ${(err as Error).message}` },
        }),
      }
    }
  }
  // default: JSON
  try {
    return {
      ok: true,
      value:
        call.body_text != null && call.body_text !== '' ? JSON.parse(call.body_text) : undefined,
    }
  } catch (err) {
    return {
      ok: false,
      status: 400,
      body: JSON.stringify({
        error: { message: `invalid JSON body: ${(err as Error).message}` },
      }),
    }
  }
}

function actionErrorResponse(err: ActionError): RouteResponse {
  // Flat domain-error body `{ code, message, data? }` — `code` is the client-side
  // discriminator (vs the framework's enveloped `{ error: { … } }`). `data` is
  // included only when present so the wire shape omits the key entirely otherwise.
  const body: ActionErrorBody = { code: err.code, message: err.message }
  if (err.data !== undefined) body.data = err.data
  return {
    status: err.status,
    body: JSON.stringify(body),
    contentType: 'application/json; charset=utf-8',
  }
}

/** Flush any cookies staged via `cookies.set`/`cookies.delete` in the active
 * request scope onto the response headers.
 *
 * The Rust response-header writer stores worker-response headers in a
 * CASE-SENSITIVE map (no lowercase dedup), so a mix of 'Set-Cookie' /
 * 'set-cookie' would emit two lines. We therefore use the SINGLE canonical key
 * 'set-cookie' (lowercase) for ALL cookie writes.
 *
 * RouteResponse.headers is Record<string,string>, so only ONE Set-Cookie per
 * response is representable. If multiple were staged, only the LAST is sent
 * (documented limitation; dev-warn). If the handler already set a 'set-cookie'
 * header explicitly (respond({ headers })), the explicit value WINS and staged
 * cookies are dropped (dev-warn on conflict). */
function flushSetCookie(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const staged = __scope()?.setCookies ?? []
  if (staged.length === 0) return headers
  if (headers && 'set-cookie' in headers) {
    if (process.env.BRUST_DEV === '1') {
      console.warn(
        '[brust] cookies.set conflicts with an explicit set-cookie header — explicit respond() wins',
      )
    }
    return headers
  }
  if (staged.length > 1 && process.env.BRUST_DEV === '1') {
    console.warn(
      `[brust] ${staged.length} cookies staged but only one Set-Cookie per response is supported — only the last is sent`,
    )
  }
  const out = { ...(headers ?? {}) }
  out['set-cookie'] = staged[staged.length - 1]
  return out
}

export async function dispatchAction(
  call: Extract<RouteCall, { kind: 'action' }>,
  byId: Map<string, EndpointDef>,
): Promise<BranchResponse> {
  const def = byId.get(call.action_id)
  if (!def) {
    return {
      status: 404,
      body: '{"error":{"message":"unknown action"}}',
      contentType: 'application/json; charset=utf-8',
    }
  }
  call.req.signal = NEVER_ABORTS

  // Body decode — dispatch by content-type (JSON / urlencoded / multipart).
  let rawBody: unknown
  if (def.method !== 'GET' && def.method !== 'HEAD') {
    const decoded = await decodeActionBody(call)
    if (!decoded.ok) {
      return {
        status: decoded.status,
        body: decoded.body,
        contentType: 'application/json; charset=utf-8',
      }
    }
    rawBody = decoded.value
  }

  const bodyCheck = await validate(def.body, rawBody)
  if (!bodyCheck.ok) {
    return {
      status: 422,
      body: JSON.stringify({
        error: { message: 'body validation failed', issues: bodyCheck.issues },
      }),
      contentType: 'application/json; charset=utf-8',
    }
  }
  // `req.search` already arrives as a parsed key→value object from the Rust
  // envelope (BrustRequest.search: Record<string, string>) — use it directly
  // as the query object rather than re-parsing it as a string.
  const queryObj = call.req.search ?? {}
  const queryCheck = await validate(def.query, queryObj)
  if (!queryCheck.ok) {
    return {
      status: 422,
      body: JSON.stringify({
        error: { message: 'query validation failed', issues: queryCheck.issues },
      }),
      contentType: 'application/json; charset=utf-8',
    }
  }

  const ctx = {
    req: call.req,
    body: bodyCheck.value,
    params: call.params ?? {},
    query: queryCheck.value,
    headers: call.req.headers ?? {},
    respond: makeRespond(),
  }

  const terminal = async (): Promise<RouteResponse> => {
    try {
      const result = await def.handler(ctx as never)
      if (isRespondSentinel(result)) {
        return {
          status: result.status,
          body: result.body === undefined ? '' : JSON.stringify(result.body),
          contentType: 'application/json; charset=utf-8',
          headers: result.headers,
        }
      }
      return {
        status: 200,
        body: result === undefined ? '' : JSON.stringify(result),
        contentType: 'application/json; charset=utf-8',
      }
    } catch (err) {
      if (isActionError(err)) return actionErrorResponse(err)
      const e = err instanceof Error ? err : new Error(String(err))
      console.error(`[brust] action ${def.method} ${def.path} threw:`, err)
      return {
        status: 500,
        body: JSON.stringify({ error: { message: e.message, name: e.name } }),
        contentType: 'application/json; charset=utf-8',
      }
    }
  }

  // Open a per-request scope (OUTER) so cookies.set during middleware/handler
  // stage onto this request, then flush the staged Set-Cookie onto the response
  // headers. The cache + store scopes wrap INNER — request-scope is outermost.
  return await runInRequestContext(call.req.cookies ?? {}, async () => {
    const chain = composeChain(call.req, def.middleware, terminal)
    let response: RouteResponse
    try {
      response = await chain()
    } catch (err) {
      if (isActionError(err)) {
        response = actionErrorResponse(err)
      } else {
        console.error('[brust] action middleware uncaught:', err)
        response = {
          status: 500,
          body: '{"error":{"message":"internal error"}}',
          contentType: 'application/json; charset=utf-8',
        }
      }
    }
    return {
      status: response.status,
      body: response.body,
      contentType: response.contentType ?? 'application/json; charset=utf-8',
      headers: flushSetCookie(response.headers),
    }
  })
}

async function mcpBranchToResponse(
  call: Extract<RouteCall, { kind: 'mcp' }>,
  mcp: import('./mcp/server.ts').McpServer | undefined,
): Promise<BranchResponse> {
  if (!mcp) {
    return {
      status: 501,
      body: '{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"mcp not configured"}}',
      contentType: 'application/json; charset=utf-8',
    }
  }
  // Populate req.signal with the permanently-unaborted sentinel. MCP handler
  // reading req.signal.aborted always sees false; the SSE branch is where
  // real disconnect lives.
  call.req.signal = NEVER_ABORTS
  const responseJson = await mcp.handleRequest(call.body_text, call.req)
  if (responseJson === '') {
    // Notification — no response body. Return 204 No Content.
    return {
      status: 204,
      body: '',
      contentType: 'application/json; charset=utf-8',
    }
  }
  return {
    status: 200,
    body: responseJson,
    contentType: 'application/json; charset=utf-8',
  }
}

async function sseBranch(
  call: Extract<RouteCall, { kind: 'sse' }>,
  _view: Uint8Array,
  encoder: TextEncoder,
  routes: FlatRoute[],
): Promise<void> {
  // conn_id crosses the boundary as a JSON number (u64) but napiSse* fns
  // require BigInt. Coerce once here; reassign on the call object so
  // handleSseStream (which reads call.conn_id directly) also gets bigint.
  ;(call as any).conn_id = BigInt((call as any).conn_id)

  // Find matching FlatRoute by literal path (MVP — exact match; Rust's
  // path_is_sse gates dispatch so we only see registered paths). Strip
  // query string before matching.
  // Rust's path_is_sse uses the same literal-match registration as this
  // find — trailing-slash divergence (or any other normalization) fails
  // in lockstep on both sides, never producing silent half-state.
  const pathOnly = call.req.url.split('?')[0]
  const flat = routes.find((r) => r.fullPath === pathOnly)
  const leaf = flat?.chain[flat.chain.length - 1]

  // Build napi shim around the four napiSse* native fns. signalOpen
  // wraps the body string in a Buffer (the Rust side takes Buffer).
  // Dynamic import is consistent with mcpBranch/actionBranch — defers
  // loading the native binding until the dispatch path actually fires
  // and avoids any circular-import risk during module init.
  const native = await import('./index.js')
  const napi = {
    write: (conn_id: bigint, bytes: Uint8Array) =>
      (native as any).napiSseWrite(
        conn_id,
        Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      ),
    close: (conn_id: bigint) => (native as any).napiSseClose(conn_id),
    registerAbort: (conn_id: bigint, cb: () => void) =>
      (native as any).napiSseRegisterAbort(conn_id, cb),
    signalOpen: (conn_id: bigint, status: number, body: string, ct: string) => {
      const bodyBytes = encoder.encode(body)
      ;(native as any).napiSseSignalOpen(
        conn_id,
        status,
        Buffer.from(bodyBytes.buffer, bodyBytes.byteOffset, bodyBytes.byteLength),
        ct,
      )
    },
  }

  if (!flat || !leaf?.sse) {
    // Defensive — shouldn't reach here since Rust gates by path_is_sse.
    napi.signalOpen(call.conn_id, 404, 'not found', 'text/plain; charset=utf-8')
    napi.close(call.conn_id)
    return
  }

  // Inject NEVER_ABORTS into req for the middleware run. handleSseStream
  // will overwrite with a per-conn AbortController.signal afterward.
  call.req.signal = NEVER_ABORTS

  // Run middleware chain with a 200 placeholder terminal. The terminal
  // does NOT invoke leaf.sse — handleSseStream does that after middleware
  // approves. This keeps middleware semantics identical to action/render.
  const placeholderTerminal: () => Promise<RouteResponse> = async () => ({
    status: 200,
    body: '',
    contentType: 'text/event-stream',
  })
  const chain = composeChain(call.req, flat.middleware, placeholderTerminal)
  const verdict = await chain()

  if (verdict.status >= 400) {
    napi.signalOpen(
      call.conn_id,
      verdict.status,
      verdict.body,
      verdict.contentType ?? 'text/plain; charset=utf-8',
    )
    napi.close(call.conn_id)
    return
  }

  // Middleware OK — invoke handleSseStream which signals open 200 itself
  // and runs the reader loop until done or aborted.
  const { handleSseStream } = await import('./sse/handler.ts')
  const routeShim: Route = {
    path: flat.fullPath,
    sse: leaf.sse,
    sseOptions: leaf.sseOptions,
  }
  await handleSseStream(call, routeShim, napi)
}

async function wsBranch(
  call: Extract<RouteCall, { kind: 'ws' }>,
  _view: Uint8Array,
  encoder: TextEncoder,
  routes: FlatRoute[],
): Promise<void> {
  // Coerce conn_id from JSON.parse number → BigInt (same fix as sseBranch
  // Task 12; native binding requires BigInt since conn_ids are u64).
  ;(call as any).conn_id = BigInt(call.conn_id)

  // Find matching FlatRoute by literal fullPath (Rust path_is_ws gates
  // dispatch — same literal-match contract as SSE).
  const pathOnly = call.req.url.split('?')[0]
  const flat = routes.find((r) => r.fullPath === pathOnly)
  const leaf = flat?.chain[flat.chain.length - 1]

  // Build napi shim around the 4 napiWs* native fns. The registerHandlers
  // shim adapts from struct-arg callbacks (WsMessageArg / WsCloseArg —
  // Task 4 deviation: napi-rs rejected tuple Function args) to the
  // positional-arg handleWsConn API.
  const native = await import('./index.js')
  const napi = {
    send: (conn_id: bigint, bytes: Uint8Array, isBinary: boolean) =>
      (native as any).napiWsSend(
        conn_id,
        Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        isBinary,
      ),
    close: (conn_id: bigint, code: number, reason: string) =>
      (native as any).napiWsClose(conn_id, code, reason),
    signalOpen: (
      conn_id: bigint,
      status: number,
      body: string,
      ct: string,
      subprotocol: string,
    ) => {
      const bodyBytes = encoder.encode(body)
      ;(native as any).napiWsSignalOpen(
        conn_id,
        status,
        Buffer.from(bodyBytes.buffer, bodyBytes.byteOffset, bodyBytes.byteLength),
        ct,
        subprotocol,
      )
    },
    registerHandlers: (
      conn_id: bigint,
      onMessage: (data: Uint8Array, isBinary: boolean) => void,
      onClose: (code: number, reason: string) => void,
    ) => {
      // napi-rs delivers struct args (WsMessageArg / WsCloseArg) — adapt
      // back to positional for handleWsConn's contract.
      ;(native as any).napiWsRegisterHandlers(
        conn_id,
        (arg: { data: Uint8Array; isBinary: boolean }) => onMessage(arg.data, arg.isBinary),
        (arg: { code: number; reason: string }) => onClose(arg.code, arg.reason),
      )
    },
  }

  if (!flat || !leaf?.websocket) {
    // Defensive — Rust path_is_ws gates dispatch.
    napi.signalOpen(call.conn_id, 404, 'not found', 'text/plain; charset=utf-8', '')
    return
  }

  // Inject NEVER_ABORTS into req for middleware. There's no per-conn
  // AbortController for WS — handleWsConn doesn't create one because
  // lifecycle is via registered onMessage/onClose callbacks rather than
  // awaiting on a request signal.
  call.req.signal = NEVER_ABORTS

  // Run middleware chain with a 101 placeholder terminal that signals
  // "ready to upgrade". The terminal does NOT call route.websocket —
  // handleWsConn does that after middleware approves.
  const placeholderTerminal: () => Promise<RouteResponse> = async () => ({
    status: 101,
    body: '',
    contentType: 'application/octet-stream',
  })
  const chain = composeChain(call.req, flat.middleware, placeholderTerminal)
  const verdict = await chain()

  if (verdict.status >= 400) {
    napi.signalOpen(
      call.conn_id,
      verdict.status,
      verdict.body,
      verdict.contentType ?? 'text/plain; charset=utf-8',
      '',
    )
    return
  }

  // Middleware OK — invoke handleWsConn. It signals open 101 itself
  // (with the chosen subprotocol) and registers handlers.
  const { handleWsConn } = await import('./ws/handler.ts')
  const routeShim: Route = {
    path: flat.fullPath,
    websocket: leaf.websocket,
    wsOptions: leaf.wsOptions,
  }
  await handleWsConn(call, routeShim, napi)
}

/** Right-to-left compose a middleware chain. Each middleware wraps the next;
 * the terminal step ends up at the innermost call. Returning without calling
 * next() short-circuits. Used identically by render + action branches. */
export function composeChain(
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
