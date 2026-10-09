// Route tree, ids and loader verdicts (spec S4, S7 step 4). M2 routes carry ONLY
// `path/Component/loader/cache/children`; every other 0.1.x field fails loudly (M3).

/** Structural stand-in for React's `ComponentType` (the package has no `@types/react`; the
 * compiler, not the type, decides what a Component is). */
// biome-ignore lint/suspicious/noExplicitAny: mirrors React's ComponentType<any>
export type ComponentType<P = any> = ((props: P) => unknown) | (abstract new (props: P) => unknown)

/** Route-level page cache (S4 / §5). `key`/`key_ttl_seconds` are M3. */
export interface RouteCacheConfig {
  ttl_seconds: number
  prefix?: string
  bypass?: true | string
  tags?: string[]
}

/** The request as the server sends it in a `loader` call (`RequestEnvelope`, routing/routes.rs). */
export interface LoaderReq {
  method: string
  url: string
  headers: Record<string, string>
  cookies: Record<string, string>
  search: Record<string, string>
}

export interface LoaderCtx<P = Record<string, string>> {
  params: P
  path: string
  req: LoaderReq
}

export interface Route<P = Record<string, string>, D = unknown> {
  path?: string
  Component?: ComponentType<any>
  loader?: (ctx: LoaderCtx<P>) => Promise<D> | D
  cache?: RouteCacheConfig
  children?: Route<any, any>[]
}

export const ALLOWED_ROUTE_FIELDS = ['path', 'Component', 'loader', 'cache', 'children'] as const
const ALLOWED_CACHE_FIELDS = ['ttl_seconds', 'prefix', 'bypass', 'tags'] as const
const M3_CACHE_FIELDS = ['key', 'key_ttl_seconds'] as const

export class BrustRouteError extends Error {
  override name = 'BrustRouteError'
}

const m3 = (field: string, where: string) => new BrustRouteError(`${field} is not supported in M2 (M3) — route ${where}`)

function validate(node: Route, where: string): void {
  if (typeof node !== 'object' || node === null) throw new BrustRouteError(`route ${where} is not an object`)
  for (const field of Object.keys(node))
    if (!(ALLOWED_ROUTE_FIELDS as readonly string[]).includes(field)) throw m3(field, where)
  if (node.path !== undefined && typeof node.path !== 'string') throw new BrustRouteError(`route ${where}: path must be a string`)
  if (node.loader !== undefined && typeof node.loader !== 'function')
    throw new BrustRouteError(`route ${where}: loader must be a function`)
  if (node.cache !== undefined) {
    if (typeof node.cache !== 'object' || node.cache === null) throw new BrustRouteError(`route ${where}: cache must be an object`)
    for (const k of Object.keys(node.cache)) {
      if ((M3_CACHE_FIELDS as readonly string[]).includes(k)) throw m3(`cache.${k}`, where)
      if (!(ALLOWED_CACHE_FIELDS as readonly string[]).includes(k))
        throw new BrustRouteError(`route ${where}: unknown cache field cache.${k} (allowed: ${ALLOWED_CACHE_FIELDS.join(', ')})`)
    }
    const ttl = node.cache.ttl_seconds
    if (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl < 0)
      throw new BrustRouteError(`route ${where}: cache.ttl_seconds must be a non-negative number`)
  }
  if (node.children !== undefined) {
    if (!Array.isArray(node.children)) throw new BrustRouteError(`route ${where}: children must be an array`)
    if (node.path === '*') throw new BrustRouteError(`route ${where}: '*' must be a leaf (no children)`)
    node.children.forEach((c, i) => validate(c, `${where} > ${c?.path ?? `[${i}]`}`))
    return
  }
  if (node.path === undefined) throw new BrustRouteError(`leaf route ${where} needs a path`)
  if (node.Component === undefined) throw new BrustRouteError(`leaf route ${where} needs a Component`)
}

/** Validates the tree and returns it unchanged. */
export function defineRoutes(routes: Route<any, any>[]): Route[] {
  if (!Array.isArray(routes)) throw new BrustRouteError('defineRoutes expects an array of routes')
  routes.forEach((r, i) => validate(r, r?.path ?? `[${i}]`))
  return routes
}

/** Placeholder for the child route slot inside a layout. The compiler replaces `<Outlet/>`
 * imported from `@brust/brust/routes`; rendered by React directly it is empty. */
export function Outlet(): null {
  return null
}

export interface FlatRoute {
  /** Leaf id (`r<n>`, DFS pre-order over every node). */
  id: string
  /** Joined ancestor paths; a catch-all is `'*'` or `'<prefix>/*'`. */
  pattern: string
  /** Root → leaf nodes (layouts first). */
  chain: Route[]
  chainIds: string[]
  catchAll: boolean
}

/** Collapses `//`, strips a trailing `/` except for the root. */
function joinPath(prefix: string, path: string): string {
  const joined = `/${prefix}/${path}`.replace(/\/{2,}/g, '/')
  return joined.length > 1 ? joined.replace(/\/+$/, '') : joined
}

/** DFS pre-order ids `r0, r1, …` for every node (a layout precedes its children); a leaf is a
 * node without `children`. */
export function flattenRoutes(routes: Route[]): { nodes: Map<Route, string>; leaves: FlatRoute[] } {
  const nodes = new Map<Route, string>()
  const leaves: FlatRoute[] = []
  let next = 0
  const walk = (node: Route, prefix: string, chain: Route[], chainIds: string[]) => {
    const id = `r${next++}`
    nodes.set(node, id)
    const c = [...chain, node],
      ids = [...chainIds, id]
    if (node.children) {
      const childPrefix = node.path === undefined ? prefix : joinPath(prefix, node.path)
      for (const child of node.children) walk(child, childPrefix, c, ids)
      return
    }
    const catchAll = node.path === '*'
    let pattern: string
    if (catchAll) {
      const p = prefix.replace(/\/+$/, '')
      pattern = p ? `${p}/*` : '*'
    } else pattern = joinPath(prefix, node.path ?? '')
    leaves.push({ id, pattern, chain: c, chainIds: ids, catchAll })
  }
  for (const r of routes) walk(r, '', [], [])
  return { nodes, leaves }
}

// ---- verdicts (0.1.x runtime/routes.ts semantics and symbol keys) ----

const BRUST_VERDICT = Symbol.for('brust.nativeVerdict')

/** Returned from a loader to control the response. Build it with `notFound()` / `redirect()`. */
export interface Verdict {
  readonly [BRUST_VERDICT]: true
  readonly status: number
  readonly render: boolean
  readonly data?: unknown
  readonly headers?: Record<string, string>
}

/** Render the route's own page at HTTP 404 with `data` (default `{}`). Return it from a loader. */
export function notFound(data?: unknown): Verdict {
  return { [BRUST_VERDICT]: true, status: 404, render: true, data: data ?? {} }
}

/** Redirect without rendering. Return it from a loader. */
export function redirect(location: string, status: 301 | 302 | 303 | 307 | 308 = 302): Verdict {
  return { [BRUST_VERDICT]: true, status, render: false, headers: { Location: location } }
}

/** Symbol-keyed check: a plain object with `status` is NOT a verdict. */
export function isVerdict(x: unknown): x is Verdict {
  return typeof x === 'object' && x !== null && (x as Record<symbol, unknown>)[BRUST_VERDICT] === true
}

const HTTP_ERROR: unique symbol = Symbol.for('brust.httpError')

export interface HttpErrorOpts {
  /** Defaults: string body → `text/plain; charset=utf-8`, object body → `application/json; charset=utf-8`. */
  contentType?: string
  headers?: Record<string, string>
}

export interface HttpErrorTrigger {
  readonly [HTTP_ERROR]: true
  readonly status: number
  readonly body: string
  readonly contentType: string
  readonly headers?: Record<string, string>
}

/** Throw-only: short-circuits the response with a 400-599 status. 3xx is `redirect()`, a
 * rendered 404 is `notFound()`. */
export function httpError(status: number, body?: string | object, opts?: HttpErrorOpts): never {
  if (!Number.isInteger(status) || status < 400 || status > 599)
    throw new Error(
      `httpError(status) must be an integer in 400-599, got ${status} — use redirect() for 3xx and notFound() for a rendered 404`,
    )
  let bodyStr: string
  let contentType: string
  if (body === undefined || typeof body === 'string') {
    bodyStr = body ?? ''
    contentType = opts?.contentType ?? 'text/plain; charset=utf-8'
  } else {
    bodyStr = JSON.stringify(body)
    contentType = opts?.contentType ?? 'application/json; charset=utf-8'
  }
  const trigger: HttpErrorTrigger = { [HTTP_ERROR]: true, status, body: bodyStr, contentType, headers: opts?.headers }
  throw trigger
}

/** Symbol-keyed check for the value `httpError()` throws. */
export function isHttpErrorTrigger(x: unknown): x is HttpErrorTrigger {
  return typeof x === 'object' && x !== null && (x as Record<symbol, unknown>)[HTTP_ERROR] === true
}
