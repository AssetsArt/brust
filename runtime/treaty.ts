import type { ActionsBuilder } from './define-actions.ts'

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
  headers?: Record<string, string> | (() => Record<string, string>)
  fetch?: typeof fetch
}

type FirstSegment<S extends string> = S extends `/${infer Rest}`
  ? FirstSegment<Rest>
  : S extends `${infer T}/${infer _U}`
    ? T
    : S

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

export type Treaty<App> =
  App extends ActionsBuilder<infer Acc>
    ? { [K in FirstSegment<keyof Acc & string>]: PermissiveProxy } & PermissiveProxy
    : PermissiveProxy

function resolvePrefix(opts?: ClientOptions): string {
  if (opts?.prefix) return opts.prefix
  const g = (globalThis as { __BRUST_ACTION_PREFIX__?: string }).__BRUST_ACTION_PREFIX__
  return g ?? '/_brust/action'
}

/** Build a treaty proxy. Static segments accumulate as a path; a function call
 * with an object fills the next {param}(s) positionally (in insertion order); a
 * terminal method key (.get/.post/…) performs the request. URL is composed from
 * the literal accumulated segments — never from any inferred type. */
export function client<App = unknown>(opts?: ClientOptions): Treaty<App> {
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
            let url = prefix + '/' + segments.join('/')
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
