import { __scope } from './request-context.ts'

export interface CookieOptions {
  maxAge?: number
  expires?: Date
  path?: string
  domain?: string
  secure?: boolean
  httpOnly?: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
}

// RFC 6265 cookie-name is a token: no control chars, whitespace, or separators.
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

/** Serialize a single Set-Cookie value. The value is URL-encoded; attributes
 * are appended in a stable order. Mirrors the standard cookie attribute names.
 *
 * Hardening: the name is validated as an RFC 6265 token, and the final line is
 * asserted CRLF-free — so a stray `\r\n` in a name/path/domain (which are NOT
 * URL-encoded, unlike the value) can't smuggle an extra response header. */
export function serializeCookie(name: string, value: string, opts: CookieOptions = {}): string {
  if (!COOKIE_NAME.test(name)) {
    throw new Error(`invalid cookie name ${JSON.stringify(name)} (must be an RFC 6265 token)`)
  }
  let out = `${name}=${encodeURIComponent(value)}`
  if (opts.maxAge !== undefined) out += `; Max-Age=${opts.maxAge}`
  if (opts.expires !== undefined) out += `; Expires=${opts.expires.toUTCString()}`
  if (opts.path !== undefined) out += `; Path=${opts.path}`
  if (opts.domain !== undefined) out += `; Domain=${opts.domain}`
  if (opts.secure) out += '; Secure'
  if (opts.httpOnly) out += '; HttpOnly'
  if (opts.sameSite !== undefined) out += `; SameSite=${opts.sameSite}`
  if (/[\r\n]/.test(out)) {
    throw new Error('cookie contains CR/LF — refusing to emit (header-injection guard)')
  }
  return out
}

/** Per-request cookie helper. `get` reads the incoming request cookies; `set`
 * and `delete` stage a Set-Cookie onto the active request scope, flushed onto
 * the response by routes.ts. Outside a request scope, `set`/`delete` are no-ops
 * (dev-warn under BRUST_DEV). */
export const cookies = {
  get(name: string): string | undefined {
    return __scope()?.reqCookies[name]
  },
  set(name: string, value: string, opts?: CookieOptions): void {
    const s = __scope()
    if (!s) {
      if (process.env.BRUST_DEV === '1') {
        console.warn(`[brust] cookies.set('${name}') outside a request scope — no-op`)
      }
      return
    }
    s.setCookies.push(serializeCookie(name, value, opts))
  },
  delete(name: string, opts?: Pick<CookieOptions, 'path' | 'domain'>): void {
    cookies.set(name, '', { ...opts, maxAge: 0 })
  },
}
