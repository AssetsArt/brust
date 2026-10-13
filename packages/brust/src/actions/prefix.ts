// Browser-safe (the client imports it): no elysia import.
export const DEFAULT_ACTION_PREFIX = '/_brust/action'
export const DEFAULT_MAX_BODY_BYTES = 1_048_576
export const DEFAULT_MAX_RESPONSE_BYTES = 8_388_608
export const MAX_ACTION_BYTES = 67_108_864
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
