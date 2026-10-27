// Browser-safe (the client imports it): no elysia import.
export const DEFAULT_ACTION_PREFIX = '/_brust/action'
export const DEFAULT_MAX_BODY_BYTES = 1_048_576
export const DEFAULT_MAX_RESPONSE_BYTES = 8_388_608
export const MAX_ACTION_BYTES = 67_108_864
/** F475: `max_stream_bytes` default (256 MiB) and hard max (4 GiB); `stream_idle_ms` / `stream_total_ms` defaults. */
export const DEFAULT_MAX_STREAM_BYTES = 268_435_456
export const MAX_STREAM_BYTES = 4_294_967_296
export const DEFAULT_STREAM_IDLE_MS = 30_000
export const DEFAULT_STREAM_TOTAL_MS = 900_000
const SEG = /^[A-Za-z0-9._~-]+$/

/** Why `p` cannot be the actions prefix, or null. Segment-safe like the server's match. `root`: an actions-only
 * build (L16 R16.4) may mount at `/`; a normal build never may (its page routes would be unreachable). */
export function prefixError(p: unknown, root = false): string | null {
  if (root && p === '/') return null
  if (typeof p !== 'string' || !p.startsWith('/') || p.length < 2 || p.endsWith('/'))
    return `must start with '/', be longer than '/' and have no trailing '/' (got ${JSON.stringify(p)})`
  const segs = p.slice(1).split('/')
  if (segs.some((s) => !SEG.test(s) || s === '.' || s === '..'))
    return `segments must be [A-Za-z0-9._~-]+ and not '.'/'..' (got ${JSON.stringify(p)})`
  if (
    p === '/_brust' ||
    (p.startsWith('/_brust/') &&
      p !== DEFAULT_ACTION_PREFIX &&
      !p.startsWith(`${DEFAULT_ACTION_PREFIX}/`))
  )
    return `${p} is reserved for the server's own /_brust/ paths`
  return null
}

/** L16 R16.1: `base_url` is an absolute http(s) origin: scheme, host, optional port; no path, query, fragment or userinfo. */
export function baseUrlError(v: unknown): string | null {
  if (typeof v !== 'string' || !/^https?:\/\//.test(v))
    return `must be an absolute http(s) origin such as https://api.example.com (got ${JSON.stringify(v)})`
  let u: URL
  try {
    u = new URL(v)
  } catch {
    return `is not a valid URL (got ${JSON.stringify(v)})`
  }
  const authority = v.replace(/^https?:\/\//, '')
  if (u.search !== '' || u.hash !== '' || u.username !== '' || u.password !== '' || /[/?#@\\\s]/.test(authority))
    return `must be an origin only: no path, query, fragment or credentials (got ${JSON.stringify(v)})`
  return null
}

/** L16 R16.2: the default `RequestInit.credentials` of the browser client. */
export const ACTION_CREDENTIALS = ['same-origin', 'include', 'omit'] as const
export type ActionCredentials = (typeof ACTION_CREDENTIALS)[number]

/** F475: why `e` is not a `[actions] stream` entry (`"POST /upload"`, path relative to the prefix, `:name` one segment,
 * a final `*` the rest), or null. Mirrors Rust `StreamRoute::parse`. */
export function streamEntryError(e: unknown): string | null {
  if (typeof e !== 'string') return `must be a string "<METHOD> <path>" (got ${JSON.stringify(e)})`
  const m = /^\s*(\S+) +(\S+)\s*$/.exec(e)
  if (!m) return `must be "<METHOD> <path>" (got ${JSON.stringify(e)})`
  if (!['POST', 'PUT', 'PATCH'].includes(m[1]!.toUpperCase())) return `method must be POST, PUT or PATCH (got ${JSON.stringify(e)})`
  const path = m[2]!
  const segs = path.split('/').slice(1)
  const badStar = segs.some((s, i) => s.includes('*') && (s !== '*' || i !== segs.length - 1))
  if (!path.startsWith('/') || (path !== '/' && segs.some((s) => s === '')) || badStar)
    return `path must start with '/', have no empty segment, and use '*' only as the last segment (got ${JSON.stringify(e)})`
  return null
}
