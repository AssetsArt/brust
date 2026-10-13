// website/lib/cache-key.ts — a TypeScript port of brust's L1 cache-key expressions, for the docs playground (client-only; runs in the browser).
// Ported from the server, rule for rule:
//   grammar + evaluation: crates/brust-core/src/cache/key_expr.rs (Expr::parse :47, Expr::eval :61, build :162, ident :245, string_lit :262)
//   key parts + sorted query: crates/brust-core/src/cache/mod.rs (build_cache_key :93, sort_query :106 — byte order)
//   the request data an expression sees, bypass, ambiguity bypass: crates/brust-core/src/pipeline.rs (l1_decision :1069)
//   query decoding (%xx and +): crates/brust-core/src/routing/routes.rs (decode_search :267, url_decode :414)
// website/test/cache-key.test.ts runs key_expr.rs's own test vectors against this file, and replays the docs examples against a real `brust start`.
// Differences on purpose: strings are JS strings parsed over their UTF-8 bytes (so byte offsets in errors match the server); `env()` reads a map you pass.

export type Expr =
  | { t: 'header' | 'cookie' | 'query' | 'param' | 'request' | 'lit'; v: string }
  | { t: 'env'; v: string }
  | { t: 'or' | 'and' | 'concat'; args: Expr[] }
  | { t: 'eq'; a: Expr; b: Expr; v: Expr | null }
  | { t: 'lower' | 'upper'; a: Expr }

export class CacheExprError extends Error {
  override name = 'CacheExprError'
}

export interface ParseOptions {
  /** Process env at route install (frozen into the expression). */
  env?: Record<string, string>
  /** Cloudflare Workers has no process env: `env()` refuses to compile (key_expr.rs:290 env_unavailable). */
  workers?: boolean
}

const enc = new TextEncoder()
const dec = new TextDecoder()
const isWs = (b: number) => b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0c || b === 0x0d
const isIdent = (b: number) => (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || b === 0x5f || b === 0x2d

class Parser {
  i = 0
  constructor(
    readonly s: Uint8Array,
    readonly opts: ParseOptions,
  ) {}
  ws() {
    while (this.i < this.s.length && isWs(this.s[this.i]!)) this.i++
  }
  expr(): Expr {
    this.ws()
    const c = this.s[this.i]
    if (this.i < this.s.length && (c === 0x27 || c === 0x22)) return { t: 'lit', v: this.str() }
    const id = this.ident()
    this.ws()
    // A bare identifier (no '(') is a string literal: header(Authorization).
    if (this.i >= this.s.length || this.s[this.i] !== 0x28) return { t: 'lit', v: id }
    this.i++
    const args = this.args()
    this.expect(0x29, ')')
    return this.build(id, args)
  }
  args(): Expr[] {
    const out: Expr[] = []
    this.ws()
    if (this.i < this.s.length && this.s[this.i] === 0x29) return out
    for (;;) {
      out.push(this.expr())
      this.ws()
      const c = this.s[this.i]
      if (c === 0x2c) {
        this.i++
        this.ws()
      } else if (c === 0x29) return out
      else throw new CacheExprError("cache expression: expected ',' or ')'")
    }
  }
  build(id: string, args: Expr[]): Expr {
    const one = (): string => {
      if (args.length === 1 && args[0]!.t === 'lit') return (args[0] as { v: string }).v
      if (args.length === 1) throw new CacheExprError(`cache expression: ${id}() argument must be a string literal`)
      throw new CacheExprError(`cache expression: ${id}() takes exactly one argument`)
    }
    switch (id) {
      case 'header':
      case 'cookie':
      case 'query':
      case 'param':
        return { t: id, v: one() }
      case 'request': {
        const f = one()
        if (f === 'host' || f === 'method' || f === 'scheme' || f === 'path') return { t: 'request', v: f }
        throw new CacheExprError(`cache expression: request('${f}') — field must be host|method|scheme|path`)
      }
      case 'env': {
        const name = one()
        if (this.opts.workers) throw new CacheExprError(`cache expression: env('${name}') is not available on Cloudflare Workers (no process env); use a literal`)
        return { t: 'env', v: this.opts.env?.[name] ?? '' }
      }
      case 'or':
      case 'and':
      case 'concat':
        if (args.length === 0) throw new CacheExprError(`cache expression: ${id}() needs >= 1 argument`)
        return { t: id, args }
      case 'lower':
      case 'upper':
        if (args.length !== 1) throw new CacheExprError(`cache expression: ${id}() takes one argument`)
        return { t: id, a: args[0]! }
      case 'eq':
        if (args.length === 2) return { t: 'eq', a: args[0]!, b: args[1]!, v: null }
        if (args.length === 3) return { t: 'eq', a: args[0]!, b: args[1]!, v: args[2]! }
        throw new CacheExprError('cache expression: eq() takes 2 or 3 arguments')
      case 'uuid':
      case 'timestamp':
        throw new CacheExprError(`cache expression: ${id}() is non-deterministic and not allowed in cache keys`)
      default:
        throw new CacheExprError(`cache expression: unknown function '${id}'`)
    }
  }
  ident(): string {
    const start = this.i
    while (this.i < this.s.length && isIdent(this.s[this.i]!)) this.i++
    if (this.i === start) throw new CacheExprError(`cache expression: expected identifier at byte ${start}`)
    return dec.decode(this.s.subarray(start, this.i))
  }
  str(): string {
    const quote = this.s[this.i]!
    this.i++
    const start = this.i
    while (this.i < this.s.length && this.s[this.i] !== quote) this.i++
    if (this.i >= this.s.length) throw new CacheExprError('cache expression: unterminated string literal')
    const out = dec.decode(this.s.subarray(start, this.i))
    this.i++
    return out
  }
  expect(c: number, ch: string) {
    this.ws()
    if (this.s[this.i] === c) this.i++
    else throw new CacheExprError(`cache expression: expected '${ch}'`)
  }
}

/** Throws `CacheExprError` with the server's message. */
export function parseExpr(src: string, opts: ParseOptions = {}): Expr {
  const p = new Parser(enc.encode(src), opts)
  p.ws()
  const e = p.expr()
  p.ws()
  if (p.i !== p.s.length) throw new CacheExprError(`cache expression: trailing input at byte ${p.i}`)
  return e
}

/** Borrowed request data an expression reads (key_expr.rs:15 EvalCtx). */
export interface EvalCtx {
  headers: [string, string][]
  cookies: [string, string][]
  query: [string, string][]
  params: [string, string][]
  method: string
  host: string
  scheme: string
  /** The path without the query string. */
  path: string
}

const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase())
const asciiUpper = (s: string) => s.replace(/[a-z]/g, (c) => c.toUpperCase())
const lookup = (pairs: [string, string][], name: string) => pairs.find(([k]) => asciiLower(k) === asciiLower(name))?.[1] ?? ''

export function evalExpr(e: Expr, ctx: EvalCtx): string {
  switch (e.t) {
    case 'header':
      return lookup(ctx.headers, e.v)
    case 'cookie':
      return lookup(ctx.cookies, e.v)
    case 'query':
      return lookup(ctx.query, e.v)
    case 'param':
      return lookup(ctx.params, e.v)
    case 'request':
      return e.v === 'host' ? ctx.host : e.v === 'method' ? ctx.method : e.v === 'scheme' ? ctx.scheme : ctx.path
    case 'env':
    case 'lit':
      return e.v
    case 'or':
      return e.args.map((a) => evalExpr(a, ctx)).find((v) => v !== '') ?? ''
    case 'and': {
      const vals = e.args.map((a) => evalExpr(a, ctx))
      return vals.every((v) => v !== '') ? vals.join('\u001f') : ''
    }
    case 'concat':
      return e.args.map((a) => evalExpr(a, ctx)).join('')
    case 'eq': {
      const av = evalExpr(e.a, ctx)
      return av === evalExpr(e.b, ctx) ? (e.v ? evalExpr(e.v, ctx) : av) : ''
    }
    case 'lower':
      return asciiLower(evalExpr(e.a, ctx))
    case 'upper':
      return asciiUpper(evalExpr(e.a, ctx))
  }
}

/** routes.rs:414 url_decode: %xx and '+', an unrecognised escape passes through, invalid UTF-8 collapses to "". */
export function urlDecode(s: string): string {
  if (!s.includes('+') && !s.includes('%')) return s
  const b = enc.encode(s)
  const out: number[] = []
  let i = 0
  while (i < b.length) {
    const c = b[i]!
    if (c === 0x2b) {
      out.push(0x20)
      i++
    } else if (c === 0x25 && i + 2 < b.length) {
      const hex = String.fromCharCode(b[i + 1]!, b[i + 2]!)
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        out.push(Number.parseInt(hex, 16))
        i += 3
      } else {
        out.push(c)
        i++
      }
    } else {
      out.push(c)
      i++
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(out))
  } catch {
    return ''
  }
}

/** routes.rs:267 decode_search. */
export function decodeSearch(query: string): [string, string][] {
  const out: [string, string][] = []
  for (const pair of query.split('&')) {
    if (pair === '') continue
    const at = pair.indexOf('=')
    out.push(at < 0 ? [urlDecode(pair), ''] : [urlDecode(pair.slice(0, at)), urlDecode(pair.slice(at + 1))])
  }
  return out
}

const byteCompare = (a: string, b: string): number => {
  const x = enc.encode(a)
  const y = enc.encode(b)
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!
  return x.length - y.length
}

/** mod.rs:108 sort_query: raw pairs, byte order, empty pairs dropped. */
export function sortQuery(query: string): string {
  return query === '' ? '' : query.split('&').filter((p) => p !== '').sort(byteCompare).join('&')
}

export interface CacheKey {
  prefix: string
  method: string
  path: string
  sortedQuery: string
}

/** mod.rs:93 build_cache_key. */
export function buildCacheKey(method: string, fullPath: string, prefix: string): CacheKey {
  const q = fullPath.indexOf('?')
  return { prefix, method, path: q < 0 ? fullPath : fullPath.slice(0, q), sortedQuery: q < 0 ? '' : sortQuery(fullPath.slice(q + 1)) }
}

/** pipeline.rs:1042 last_wins: the last value per exact name, in first-seen order. */
export function lastWins(pairs: [string, string][]): [string, string][] {
  const out: [string, string][] = []
  for (const [k, v] of pairs) {
    const hit = out.find(([n]) => n === k)
    if (hit) hit[1] = v
    else out.push([k, v])
  }
  return out
}

/** pipeline.rs:1055 ci_collision: two distinct names equal ignoring ASCII case. */
export function ciCollision(pairs: [string, string][]): boolean {
  return pairs.some(([a], i) => pairs.slice(i + 1).some(([b]) => asciiLower(a) === asciiLower(b)))
}

export interface RouteCache {
  prefix?: string
  bypass?: true | string
}

export interface PlaygroundRequest {
  /** Path and query string as sent: `/p/42?b=2&a=1`. */
  url: string
  /** Request headers (names in any case, `cookie` excluded: use `cookies`). */
  headers: [string, string][]
  /** The cookies sent, in order (they travel in one Cookie header). */
  cookies: [string, string][]
  /** Route params (decoded). */
  params: [string, string][]
  host: string
  scheme?: string
}

export type Decision =
  | { outcome: 'BYPASS'; why: 'always' | 'expression' | 'repeated-query-name' | 'case-colliding-names'; bypassValue?: string }
  | { outcome: 'KEY'; prefix: string; key: CacheKey }

/** pipeline.rs:1069 l1_decision for a GET: bypass first, then the prefix, then the key. Throws `CacheExprError` for a bad expression. */
export function decide(route: RouteCache, req: PlaygroundRequest, opts: ParseOptions = {}): Decision {
  const bypassExpr = typeof route.bypass === 'string' ? parseExpr(route.bypass, opts) : null
  const prefixExpr = route.prefix !== undefined ? parseExpr(route.prefix, opts) : null
  const q = req.url.indexOf('?')
  const query = q < 0 ? '' : req.url.slice(q + 1)
  const search = query === '' ? [] : decodeSearch(query)
  // a query name repeated after decoding: the server bypasses (pipeline.rs:1085-1089)
  if (new Set(search.map(([k]) => k)).size !== search.length) return { outcome: 'BYPASS', why: 'repeated-query-name' }
  const headers = lastWins([...req.headers.map(([k, v]) => [asciiLower(k), v] as [string, string]), ['host', req.host]])
  const cookies = lastWins(req.cookies)
  const querys = lastWins(search)
  if (ciCollision(headers) || ciCollision(cookies) || ciCollision(querys)) return { outcome: 'BYPASS', why: 'case-colliding-names' }
  const ctx: EvalCtx = {
    headers,
    cookies,
    query: querys,
    params: req.params,
    method: 'GET',
    host: req.host,
    scheme: req.scheme ?? 'http',
    path: q < 0 ? req.url : req.url.slice(0, q),
  }
  if (route.bypass === true) return { outcome: 'BYPASS', why: 'always' }
  if (bypassExpr) {
    const v = evalExpr(bypassExpr, ctx)
    if (v !== '') return { outcome: 'BYPASS', why: 'expression', bypassValue: v }
  }
  const prefix = prefixExpr ? evalExpr(prefixExpr, ctx) : ''
  return { outcome: 'KEY', prefix, key: buildCacheKey('GET', req.url, prefix) }
}

/** One string for a key (what two requests must share to share an entry). */
export const keyString = (k: CacheKey): string => [k.prefix, k.method, k.path, k.sortedQuery].join('\u0000')

export interface PlaygroundInput {
  prefix: string
  bypass: string
  /** Path and query: `/ex/lang?x=1`. */
  url: string
  host: string
  /** `name=value; name2=value2` */
  cookies: string
  /** One `name: value` per line. */
  headers: string
  /** `name=value` pairs separated by `;` or newlines (route params). */
  params: string
  /** `NAME=value` per line: the process env the server was started with. */
  env: string
}

export type PlaygroundResult =
  | { ok: false; error: string }
  | { ok: true; outcome: 'BYPASS'; why: string }
  | { ok: true; outcome: 'KEY'; prefix: string; key: CacheKey }

const pairsOf = (text: string, sep: RegExp, eq: string): [string, string][] =>
  text
    .split(sep)
    .map((l) => l.trim())
    .filter((l) => l !== '' && l.includes(eq))
    .map((l) => [l.slice(0, l.indexOf(eq)).trim(), l.slice(l.indexOf(eq) + eq.length).trim()] as [string, string])

/** The playground's one call: the same decision the server makes for a GET, from the text the reader typed. */
export function evaluatePlayground(i: PlaygroundInput): PlaygroundResult {
  try {
    const env = Object.fromEntries(pairsOf(i.env, /\n/, '='))
    const route: RouteCache = {}
    if (i.prefix.trim() !== '') route.prefix = i.prefix
    if (i.bypass.trim() === 'true') route.bypass = true
    else if (i.bypass.trim() !== '') route.bypass = i.bypass
    const d = decide(
      route,
      { url: i.url.startsWith('/') ? i.url : `/${i.url}`, host: i.host.trim(), headers: pairsOf(i.headers, /\n/, ':'), cookies: pairsOf(i.cookies, /;/, '='), params: pairsOf(i.params, /[;\n]/, '=') },
      { env },
    )
    return d.outcome === 'BYPASS'
      ? { ok: true, outcome: 'BYPASS', why: d.why === 'expression' ? `the bypass expression is not empty (${JSON.stringify(d.bypassValue)})` : d.why === 'always' ? 'bypass is true' : d.why === 'repeated-query-name' ? 'a query name is sent twice' : 'two names differ only in case' }
      : { ok: true, outcome: 'KEY', prefix: d.prefix, key: d.key }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
