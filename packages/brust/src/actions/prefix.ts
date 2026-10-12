// Browser-safe (the client imports it): no elysia import.
export const DEFAULT_ACTION_PREFIX = '/_brust/action'
export const DEFAULT_MAX_BODY_BYTES = 1_048_576
export const DEFAULT_MAX_RESPONSE_BYTES = 8_388_608
export const MAX_ACTION_BYTES = 67_108_864
const SEG = /^[A-Za-z0-9._~-]+$/

/** Why `p` cannot be the actions prefix, or null. Segment-safe like the server's match. */
export function prefixError(p: unknown): string | null {
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
