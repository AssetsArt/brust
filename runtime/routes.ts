import { createContext, createElement, useContext, type ComponentType, type ReactNode } from 'react'
import { renderToString } from 'react-dom/server'
import { Buffer } from 'node:buffer'
import { consumeIslandUsedFlag } from './islands/island.tsx'
import type { ActionDef } from './actions.ts'

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
  /** Relative path segment (matchit syntax). Empty string `''` = layout-only
   * (this node contributes nothing to the path; children attach to ancestors).
   * Mutually exclusive with `index: true`. */
  path?: string
  /** Index route — matches the parent path exactly. Must be a leaf (no
   * `children`, no `path`). Mutually exclusive with `path`. */
  index?: boolean
  Component?: ComponentType<RouteContext<Params, Data>>
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
  sse?: (req: BrustRequest) => ReadableStream<Uint8Array | string> | Promise<ReadableStream<Uint8Array | string>>
  sseOptions?: {
    /** Auto-emit `: ping\n\n` every N ms. Default 15000. Set 0 to disable. */
    heartbeatMs?: number
  }
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
  if (r.path !== undefined && r.path.startsWith('/') && basePath !== '') {
    // Absolute children under a non-empty parent are a footgun (the child
    // escapes the parent's URL space). Only allowed when the parent is
    // layout-only (basePath === '').
    throw new Error(
      `route under "${basePath}": absolute child path "${r.path}" must be under a pathless ('') parent`,
    )
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
}

/** Walk the nested route tree, emitting one FlatRoute per leaf or index node.
 * Composes paths, middleware, errorBoundary, and cache per the rules in
 * the design spec (§3). */
export function flattenRoutes(routes: Route[]): FlatRoute[] {
  const out: FlatRoute[] = []
  walkRoutes(routes, [], '', out)
  return out
}

function walkRoutes(
  routes: Route[],
  parentChain: Route[],
  basePath: string,
  out: FlatRoute[],
): void {
  for (const r of routes) {
    validateRoute(r, basePath)
    const chain = [...parentChain, r]

    if (r.index === true) {
      out.push(makeFlat(chain, basePath))
      continue
    }

    const ownPath = r.path ?? ''
    const myPath = joinPath(basePath, ownPath)

    if (r.children && r.children.length > 0) {
      walkRoutes(r.children, chain, myPath, out)
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
  const cache = chain[chain.length - 1].cache
  return { fullPath, chain, middleware, errorBoundary, cache }
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
  actions?: ActionDef[]
  /** MCP server instance — built once per worker at module top-level. */
  mcp?: import('./mcp/server.ts').McpServer
}

export function makeRenderer(
  routes: FlatRoute[],
  view: Uint8Array,
  opts: MakeRendererOptions = {},
): (envelopeJson: string) => Promise<number> {
  const encoder = new TextEncoder()
  const byRouteId = new Map<number, FlatRoute>()
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
    if (call.kind === 'mcp') {
      return mcpBranch(call, view, encoder, opts.mcp)
    }
    if (call.kind === 'sse') {
      try {
        return await sseBranch(call, view, encoder, routes)
      } catch (err) {
        console.error('[brust] sseBranch uncaught:', err)
        return packResponse(view, encoder, { status: 500, body: '', contentType: 'text/plain' })
      }
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
  byId: Map<number, FlatRoute>,
  view: Uint8Array,
  encoder: TextEncoder,
  getWorkerId?: () => number | null,
): Promise<number> {
  const flat = byId.get(call.route_id)
  if (!flat) {
    console.error(`[brust] unknown route_id=${call.route_id} for path=${call.path}`)
    return 0
  }
  // BrustRequest.signal is required by the type. The envelope from Rust
  // doesn't carry one; populate with the permanently-unaborted sentinel so
  // middleware/loaders/components can safely read req.signal.aborted on
  // non-SSE routes (always false; listeners never fire). SSE branch
  // overwrites with a per-conn AbortController.signal (handler.ts).
  call.req.signal = NEVER_ABORTS
  const workerId = getWorkerId ? getWorkerId() : null
  const chainNodes = flat.chain

  const terminal = async (): Promise<RouteResponse> => {
    try {
      // 1. Run loaders top-down (parent → leaf). Each Component receives ONLY
      //    its own loader's data — no merge, no inheritance.
      const datas: unknown[] = new Array(chainNodes.length)
      for (let i = 0; i < chainNodes.length; i++) {
        const r = chainNodes[i]
        datas[i] = r.loader
          ? await r.loader({ params: call.params, path: call.path, req: call.req })
          : undefined
      }

      // 2. Build the React element bottom-up. Each level wraps the deeper level
      //    via <OutletContext.Provider value={renderedChild}>; <Outlet /> in any
      //    parent Component returns that value.
      let element: ReactNode = null
      for (let i = chainNodes.length - 1; i >= 0; i--) {
        const r = chainNodes[i]
        const node = createElement(r.Component!, {
          params: call.params,
          path: call.path,
          data: datas[i],
          workerId,
          req: call.req,
        })
        element = createElement(OutletContext.Provider, { value: element }, node)
      }

      const html = renderToString(element)
      const wrapped = consumeIslandUsedFlag()
        ? wrapWithIslandsBootstrap(html)
        : html
      return { status: 200, body: wrapped }
    } catch (renderErr) {
      if (!flat.errorBoundary) throw renderErr
      const boundary: ReactNode = createElement(flat.errorBoundary, {
        error: renderErr instanceof Error ? renderErr : new Error(String(renderErr)),
      })
      const html = renderToString(boundary)
      const wrapped = consumeIslandUsedFlag()
        ? wrapWithIslandsBootstrap(html)
        : html
      return { status: 500, body: wrapped }
    }
  }

  const chain = composeChain(call.req, flat.middleware, terminal)

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
  // Populate req.signal with the permanently-unaborted sentinel (see
  // renderBranch comment). Action handlers reading req.signal.aborted
  // always see false; the SSE branch is where real disconnect lives.
  call.req.signal = NEVER_ABORTS

  // Decode the body into the args array that will be spread into the handler.
  // Three paths: multipart (body_b64), form-urlencoded (body_text), or JSON (body_text).
  // Body decode happens BEFORE middleware so a malformed body 400s without running
  // any user code.
  let args: unknown[]
  try {
    if (call.body_b64 !== undefined) {
      // Multipart path — base64 → bytes → Web Request.formData()
      const bytes = Buffer.from(call.body_b64, 'base64')
      const synthReq = new Request('http://x', {
        method: 'POST',
        headers: { 'Content-Type': call.content_type },
        body: bytes,
      })
      const fd = await synthReq.formData()
      args = [fd]
    } else if (call.content_type.toLowerCase().startsWith('application/x-www-form-urlencoded')) {
      // Form-urlencoded path — URLSearchParams → FormData
      const params = new URLSearchParams(call.body_text ?? '')
      const fd = new FormData()
      for (const [k, v] of params) fd.append(k, v)
      args = [fd]
    } else {
      // JSON path (default — empty or application/json content type).
      const decoded = JSON.parse(call.body_text ?? '') as unknown
      if (!Array.isArray(decoded)) {
        return packResponse(view, encoder, {
          status: 400,
          body: '{"error":{"message":"args must be a JSON array"}}',
          contentType: 'application/json; charset=utf-8',
        })
      }
      args = decoded
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return packResponse(view, encoder, {
      status: 400,
      body: JSON.stringify({ error: { message: `invalid request body: ${msg}` } }),
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

async function mcpBranch(
  call: Extract<RouteCall, { kind: 'mcp' }>,
  view: Uint8Array,
  encoder: TextEncoder,
  mcp: import('./mcp/server.ts').McpServer | undefined,
): Promise<number> {
  if (!mcp) {
    return packResponse(view, encoder, {
      status: 501,
      body: '{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"mcp not configured"}}',
      contentType: 'application/json; charset=utf-8',
    })
  }
  // Populate req.signal with the permanently-unaborted sentinel (see
  // renderBranch comment). MCP handler reading req.signal.aborted always
  // sees false; the SSE branch is where real disconnect lives.
  call.req.signal = NEVER_ABORTS
  const responseJson = await mcp.handleRequest(call.body_text, call.req)
  if (responseJson === '') {
    // Notification — no response body. Return 204 No Content via meta envelope.
    return packResponse(view, encoder, {
      status: 204,
      body: '',
      contentType: 'application/json; charset=utf-8',
    })
  }
  return packResponse(view, encoder, {
    status: 200,
    body: responseJson,
    contentType: 'application/json; charset=utf-8',
  })
}

async function sseBranch(
  call: Extract<RouteCall, { kind: 'sse' }>,
  view: Uint8Array,
  encoder: TextEncoder,
  routes: FlatRoute[],
): Promise<number> {
  // conn_id crosses the boundary as a JSON number (u64) but napiSse* fns
  // require BigInt. Coerce once here; reassign on the call object so
  // handleSseStream (which reads call.conn_id directly) also gets bigint.
  ;(call as any).conn_id = BigInt((call as any).conn_id)

  // Find matching FlatRoute by literal path (MVP — exact match; Rust's
  // path_is_sse gates dispatch so we only see registered paths). Strip
  // query string before matching.
  const pathOnly = call.req.url.split('?')[0]
  const flat = routes.find((r) => r.fullPath === pathOnly)
  const leaf = flat?.chain[flat.chain.length - 1]

  // Build napi shim around the four napiSse* native fns. signalOpen
  // wraps the body string in a Buffer (the Rust side takes Buffer).
  const native = await import('./index.js')
  const napi = {
    write: (conn_id: bigint, bytes: Uint8Array) =>
      (native as any).napiSseWrite(conn_id, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)),
    close: (conn_id: bigint) =>
      (native as any).napiSseClose(conn_id),
    registerAbort: (conn_id: bigint, cb: () => void) =>
      (native as any).napiSseRegisterAbort(conn_id, cb),
    signalOpen: (conn_id: bigint, status: number, body: string, ct: string) => {
      const bodyBytes = encoder.encode(body)
      ;(native as any).napiSseSignalOpen(
        conn_id, status,
        Buffer.from(bodyBytes.buffer, bodyBytes.byteOffset, bodyBytes.byteLength),
        ct,
      )
    },
  }

  if (!flat || !leaf || !leaf.sse) {
    // Defensive — shouldn't reach here since Rust gates by path_is_sse.
    napi.signalOpen(call.conn_id, 404, 'not found', 'text/plain; charset=utf-8')
    napi.close(call.conn_id)
    return packResponse(view, encoder, { status: 200, body: '', contentType: 'text/plain' })
  }

  // Inject NEVER_ABORTS into req for the middleware run. handleSseStream
  // will overwrite with a per-conn AbortController.signal afterward.
  call.req.signal = NEVER_ABORTS

  // Run middleware chain with a 200 placeholder terminal. The terminal
  // does NOT invoke leaf.sse — handleSseStream does that after middleware
  // approves. This keeps middleware semantics identical to action/render.
  const placeholderTerminal: () => Promise<RouteResponse> = async () => ({
    status: 200, body: '', contentType: 'text/event-stream',
  })
  const chain = composeChain(call.req, flat.middleware, placeholderTerminal)
  const verdict = await chain()

  if (verdict.status >= 400) {
    napi.signalOpen(
      call.conn_id, verdict.status, verdict.body,
      verdict.contentType ?? 'text/plain; charset=utf-8',
    )
    napi.close(call.conn_id)
    return packResponse(view, encoder, { status: 200, body: '', contentType: 'text/plain' })
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
  return packResponse(view, encoder, { status: 200, body: '', contentType: 'text/event-stream' })
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
