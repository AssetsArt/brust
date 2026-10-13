// website/test/cache-key.test.ts — lib/cache-key.ts against the Rust test vectors of crates/brust-core/src/cache/key_expr.rs (:296-424), the key
// parts (cache/mod.rs), query decoding (routing/routes.rs url_decode tests) and the pipeline's ambiguity bypasses.
import { expect, test } from 'bun:test'
import { buildCacheKey, CacheExprError, ciCollision, decide, decodeSearch, type EvalCtx, evalExpr, lastWins, parseExpr, sortQuery, urlDecode } from '../lib/cache-key'

// key_expr.rs:300 ctx()
const ctx: EvalCtx = {
  headers: [['authorization', 'Bearer x'], ['x-tenant', 'acme']],
  cookies: [['session', 's1'], ['currency', 'thb']],
  query: [['sort', 'new']],
  params: [['id', '42']],
  method: 'GET',
  host: 'shop.example.com',
  scheme: 'https',
  path: '/p/42',
}
const ev = (src: string) => evalExpr(parseExpr(src), ctx)

test('key_expr.rs vectors: accessors, request fields, case-insensitive names', () => {
  expect(ev('request(path)')).toBe('/p/42')
  expect(ev('header(Authorization)')).toBe('Bearer x')
  expect(ev('cookie(currency)')).toBe('thb')
  expect(ev('cookie(nope)')).toBe('')
  expect([ev('query(sort)'), ev('param(id)'), ev('request(host)'), ev('request(method)'), ev('request(scheme)')]).toEqual(['new', '42', 'shop.example.com', 'GET', 'https'])
})

test('key_expr.rs vectors: or, and, concat, eq (2 and 3 args), lower, upper, nesting', () => {
  expect(ev('or(cookie(nope), header(x-tenant), "d")')).toBe('acme')
  expect(ev('or(cookie(nope), header(nope))')).toBe('')
  expect(ev('and(request(host), cookie(currency))')).toBe('shop.example.com\u001fthb')
  expect(ev('and(request(host), cookie(nope))')).toBe('')
  expect(ev('concat("v2-", cookie(currency))')).toBe('v2-thb')
  expect(ev('eq(request(method), "GET", "yes")')).toBe('yes')
  expect(ev('eq(request(method), "POST", "yes")')).toBe('')
  expect(ev('eq(cookie(currency), "thb")')).toBe('thb')
  expect([ev('upper(cookie(currency))'), ev('lower(request(host))')]).toEqual(['THB', 'shop.example.com'])
  expect(ev('or(and(cookie(nope), cookie(currency)), "fb")')).toBe('fb')
})

test('key_expr.rs vectors: everything the parser rejects, with the server messages', () => {
  const bad: [string, RegExp][] = [
    ['request(referrer)', /field must be host\|method\|scheme\|path/],
    ['uuid(v4)', /non-deterministic/],
    ['timestamp()', /non-deterministic/],
    ['frobnicate(x)', /unknown function 'frobnicate'/],
    ['or()', /or\(\) needs >= 1 argument/],
    ['and()', /and\(\) needs >= 1 argument/],
    ['or(cookie(x)', /expected ',' or '\)'/],
    ['header(a, b)', /takes exactly one argument/],
    ['eq(a)', /eq\(\) takes 2 or 3 arguments/],
    ['header(or(a))', /must be a string literal/],
    ["'abc", /unterminated string literal/],
    ['cookie(a) b', /trailing input at byte 10/],
    ['', /expected identifier at byte 0/],
  ]
  for (const [src, msg] of bad) {
    expect(() => parseExpr(src), src).toThrow(CacheExprError)
    expect(() => parseExpr(src), src).toThrow(msg)
  }
  // byte offsets are UTF-8 bytes, like the server: é is two bytes
  expect(() => parseExpr("'é' x")).toThrow(/trailing input at byte 5/)
})

test('env(): frozen at parse; refused on Workers (key_expr.rs:290)', () => {
  expect(evalExpr(parseExpr("concat(env(BUILD_ID), ':', param(id))", { env: { BUILD_ID: 'r1' } }), ctx)).toBe('r1:42')
  expect(evalExpr(parseExpr('env(NOPE)'), ctx)).toBe('')
  expect(() => parseExpr('env(X)', { workers: true })).toThrow(/env\('X'\) is not available on Cloudflare Workers/)
})

test('url_decode vectors (routes.rs:572-620) and decode_search', () => {
  expect([urlDecode('abc'), urlDecode(''), urlDecode('a+b'), urlDecode('%41'), urlDecode('%4f'), urlDecode('%4F'), urlDecode('%E2%9C%93')]).toEqual(['abc', '', 'a b', 'A', 'O', 'O', '✓'])
  expect([urlDecode('%'), urlDecode('a%'), urlDecode('%4'), urlDecode('%ZZ'), urlDecode('%G1')]).toEqual(['%', 'a%', '%4', '%ZZ', '%G1'])
  expect(urlDecode('%FF%FE')).toBe('')
  expect(decodeSearch('a=%41&b+c=1&&d')).toEqual([['a', 'A'], ['b c', '1'], ['d', '']])
})

test('key parts: the query is sorted raw (byte order), the path loses its query, helpers match the pipeline', () => {
  expect(buildCacheKey('GET', '/x?b=2&a=1', 'p')).toEqual({ prefix: 'p', method: 'GET', path: '/x', sortedQuery: 'a=1&b=2' })
  expect(sortQuery('b=2&&a=1')).toBe('a=1&b=2')
  expect(buildCacheKey('GET', '/x', '').sortedQuery).toBe('')
  expect(buildCacheKey('GET', '/x?lang=%54H', '')).not.toEqual(buildCacheKey('GET', '/x?lang=TH', ''))
  expect(lastWins([['a', '1'], ['b', '2'], ['a', '3']])).toEqual([['a', '3'], ['b', '2']])
  expect(ciCollision([['session', ''], ['Session', 'x']])).toBe(true)
  expect(ciCollision(lastWins([['a', '1'], ['b', '2'], ['a', '3']]))).toBe(false)
})

test('decide(): bypass first, then the prefix; ambiguous requests bypass (pipeline.rs:1085-1119)', () => {
  const req = (url: string, cookies: [string, string][] = []) => ({ url, headers: [] as [string, string][], cookies, params: [] as [string, string][], host: 'h' })
  const route = { bypass: 'cookie(session)', prefix: "or(eq(cookie(plan), 'pro', 'pro'), 'free')" }
  expect(decide(route, req('/p', [['session', 's']]))).toEqual({ outcome: 'BYPASS', why: 'expression', bypassValue: 's' })
  expect(decide(route, req('/p', [['plan', 'pro']]))).toMatchObject({ outcome: 'KEY', prefix: 'pro' })
  expect(decide(route, req('/p', [['plan', 'x']]))).toMatchObject({ outcome: 'KEY', prefix: 'free' })
  expect(decide({ bypass: true }, req('/p'))).toEqual({ outcome: 'BYPASS', why: 'always' })
  expect(decide({}, req('/p?a=1&a=2'))).toEqual({ outcome: 'BYPASS', why: 'repeated-query-name' })
  expect(decide({}, req('/p?a=1&%61=2'))).toEqual({ outcome: 'BYPASS', why: 'repeated-query-name' })
  expect(decide({}, req('/p', [['lang', 'th'], ['Lang', 'en']]))).toEqual({ outcome: 'BYPASS', why: 'case-colliding-names' })
  expect(decide({}, req('/p?x=1&X=2'))).toEqual({ outcome: 'BYPASS', why: 'case-colliding-names' })
  expect(() => decide({ prefix: 'nope(' }, req('/p'))).toThrow(CacheExprError)
})
