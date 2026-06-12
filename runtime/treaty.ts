import type { ActionsBuilder, EndpointEntry } from './define-actions.ts'

const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head'])

export interface TreatyResponse<Data = unknown, Err = unknown> {
  data: Data | null
  error: { status: number; value: Err } | null
  status: number
  headers: Record<string, string>
  response: Response | null
}
export interface ClientOptions {
  prefix?: string
  /** Absolute origin of ANOTHER brust deployment to target, e.g.
   * `https://api.example.com` (a path suffix like `/v2` composes by
   * concatenation). Must match `^https?://`; a trailing slash is stripped.
   * When set, the action prefix is `prefix ?? '/_brust/action'` — the global
   * `__BRUST_ACTION_PREFIX__` belongs to the SERVING app and is never
   * consulted. Cross-origin cookies: pass a `fetch` override that sets
   * `credentials: 'include'` (and configure `cors.credentials` server-side). */
  baseUrl?: string
  headers?: Record<string, string> | (() => Record<string, string>)
  fetch?: typeof fetch
}

export type PermissiveProxy = {
  (arg?: any): PermissiveProxy
  [key: string]: PermissiveProxy
} & {
  get: (options?: any) => Promise<TreatyResponse<any, any>>
  post: (body?: any, options?: any) => Promise<TreatyResponse<any, any>>
  put: (body?: any, options?: any) => Promise<TreatyResponse<any, any>>
  patch: (body?: any, options?: any) => Promise<TreatyResponse<any, any>>
  delete: (body?: any, options?: any) => Promise<TreatyResponse<any, any>>
  head: (options?: any) => Promise<TreatyResponse<any, any>>
}

// ─── Typed Treaty<App> (B2, descoped) ───────────────────────────────────────
// Static paths get fully-typed methods (output + discriminated error union);
// any param path (`{...}`) or unknown segment falls through to PermissiveProxy.
// Reference shape proven by spike5 (EXIT=0).

/** Per-method client signatures for one endpoint-entry map (the `{ GET, POST, … }`
 * object for a single path). Bodyless methods (GET/HEAD) take only options. */
type Methods<E> = {
  [M in keyof E & string as Lowercase<M>]: M extends 'GET' | 'HEAD'
    ? E[M] extends EndpointEntry
      ? (o?: {
          query?: Record<string, string>
          headers?: Record<string, string>
        }) => Promise<TreatyResponse<E[M]['output'], E[M]['error']>>
      : never
    : E[M] extends EndpointEntry
      ? (
          b?: E[M]['input'],
          o?: { headers?: Record<string, string> },
        ) => Promise<TreatyResponse<E[M]['output'], E[M]['error']>>
      : never
}

/** A path is static iff it contains no `{param}` segment. */
type IsStatic<K extends string> = K extends `${string}{${string}}${string}` ? false : true
/** Keep only the static path keys of the accumulator. */
type StaticAcc<Acc> = {
  [K in keyof Acc as K extends string ? (IsStatic<K> extends true ? K : never) : never]: Acc[K]
}
/** Given a path key `K` and the accumulated prefix `P`, the next segment after `P`. */
type Tail<K extends string, P extends string> = K extends `${P}/${infer Rest}`
  ? Rest extends `${infer H}/${string}`
    ? H
    : Rest
  : never
/** All immediate child segments under prefix `P`. */
type ChildSegs<SA, P extends string> = { [K in keyof SA]: Tail<K & string, P> }[keyof SA]
/** The entry map for the exact path `P`, if one exists. */
// biome-ignore lint/complexity/noBannedTypes: `{}` is the empty-methods identity when no exact endpoint matches the prefix
type ExactEntry<SA, P extends string> = P extends keyof SA ? SA[P] : {}
/** A treaty node: methods of the exact path + child segment nodes + permissive fallback. */
type TNode<SA, P extends string> = Methods<ExactEntry<SA, P>> & {
  [Seg in ChildSegs<SA, P> & string]: TNode<SA, `${P}/${Seg}`>
} & PermissiveProxy

export type Treaty<App> =
  App extends ActionsBuilder<infer Acc> ? TNode<StaticAcc<Acc>, ''> : PermissiveProxy

function resolvePrefix(opts?: ClientOptions): string {
  if (opts?.prefix) return opts.prefix
  // The global __BRUST_ACTION_PREFIX__ is injected by the SERVING app's pages;
  // it describes THIS origin's mount point, never a cross-origin target's.
  if (opts?.baseUrl !== undefined) return '/_brust/action'
  const g = (globalThis as { __BRUST_ACTION_PREFIX__?: string }).__BRUST_ACTION_PREFIX__
  return g ?? '/_brust/action'
}

/** Validate + normalize `baseUrl`: absolute http(s) origin, trailing slash(es)
 * stripped. Absent → '' (same-origin, byte-identical legacy behavior). */
function resolveBaseUrl(opts?: ClientOptions): string {
  const b = opts?.baseUrl
  if (b === undefined) return ''
  if (!/^https?:\/\//.test(b)) {
    throw new Error(`treaty baseUrl must be an absolute http(s) origin (got ${JSON.stringify(b)})`)
  }
  return b.replace(/\/+$/, '')
}

/** Build a treaty proxy. Static segments accumulate as a path; a function call
 * with an object fills the next {param}(s) positionally (in insertion order); a
 * terminal method key (.get/.post/…) performs the request. URL is composed from
 * the literal accumulated segments — never from any inferred type. */
export function client<App = unknown>(opts?: ClientOptions): Treaty<App> {
  const baseUrl = resolveBaseUrl(opts)
  const prefix = resolvePrefix(opts)
  const doFetch = opts?.fetch ?? fetch
  function make(segments: string[]): any {
    return new Proxy(() => {}, {
      get(_t, key: string) {
        if (METHODS.has(key)) {
          return async (arg1?: unknown, arg2?: unknown): Promise<TreatyResponse> => {
            const isBodyless = key === 'get' || key === 'head'
            const options = (isBodyless ? arg1 : arg2) as
              | { query?: Record<string, string>; headers?: Record<string, string> }
              | undefined
            const body = isBodyless ? undefined : arg1
            let url = baseUrl + prefix + '/' + segments.join('/')
            if (options?.query) {
              const qs = new URLSearchParams(options.query as Record<string, string>).toString()
              if (qs) url += '?' + qs
            }
            const baseHeaders =
              typeof opts?.headers === 'function' ? opts.headers() : (opts?.headers ?? {})
            const init: RequestInit = {
              method: key.toUpperCase(),
              headers: { ...baseHeaders, ...(options?.headers ?? {}) },
            }
            if (!isBodyless && body !== undefined) {
              if (hasFilePart(body)) {
                init.body = toFormData(body)
                // Let fetch set the multipart boundary; a stale content-type
                // (e.g. from caller headers) would break it.
                delete (init.headers as Record<string, string>)['content-type']
              } else {
                init.body = JSON.stringify(body)
                ;(init.headers as Record<string, string>)['content-type'] = 'application/json'
              }
            }
            try {
              const res = await doFetch(url, init)
              const text = await res.text()
              const parsed = text ? safeJson(text) : undefined
              const headers: Record<string, string> = {}
              res.headers.forEach((v, k) => {
                headers[k] = v
              })
              if (res.ok)
                return {
                  data: parsed ?? null,
                  error: null,
                  status: res.status,
                  headers,
                  response: res,
                }
              return {
                data: null,
                error: { status: res.status, value: parsed ?? text },
                status: res.status,
                headers,
                response: res,
              }
            } catch (err) {
              return {
                data: null,
                error: { status: 0, value: err },
                status: 0,
                headers: {},
                response: null,
              }
            }
          }
        }
        return make([...segments, key])
      },
      apply(_t, _this, args: unknown[]) {
        const arg = args[0] as Record<string, string> | undefined
        if (!arg) return make(segments)
        return make([...segments, ...Object.values(arg).map(String)])
      },
    })
  }
  return make([]) as any as Treaty<App>
}

function hasFilePart(b: unknown): boolean {
  if (b instanceof FormData || b instanceof Blob) return true
  if (b && typeof b === 'object')
    return Object.values(b as Record<string, unknown>).some((v) => v instanceof Blob)
  return false
}

function toFormData(b: unknown): FormData {
  if (b instanceof FormData) return b
  const fd = new FormData()
  for (const [k, v] of Object.entries(b as Record<string, unknown>)) {
    if (v instanceof Blob) fd.append(k, v)
    else if (v !== null && typeof v === 'object') fd.append(k, JSON.stringify(v))
    else fd.append(k, String(v))
  }
  return fd
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return s
  }
}
