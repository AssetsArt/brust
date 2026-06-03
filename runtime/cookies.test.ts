import { expect, test } from 'bun:test'
import { cookies, serializeCookie } from './cookies.ts'
import { __scope, runInRequestScope } from './request-context.ts'

test('serializeCookie emits name=value plus attributes', () => {
  const s = serializeCookie('mode', 'dark', {
    path: '/',
    maxAge: 60,
    httpOnly: true,
    sameSite: 'Lax',
  })
  expect(s).toContain('mode=dark')
  expect(s).toContain('Path=/')
  expect(s).toContain('Max-Age=60')
  expect(s).toContain('HttpOnly')
  expect(s).toContain('SameSite=Lax')
})

test('serializeCookie URL-encodes the value', () => {
  expect(serializeCookie('x', 'a b')).toBe('x=a%20b')
})

test('cookies.delete emits Max-Age=0', () => {
  const s = cookies && serializeCookie('mode', '', { path: '/', maxAge: 0 })
  expect(s).toContain('Max-Age=0')
  // and via the helper:
  let staged: string | undefined
  runInRequestScope({}, () => {
    cookies.delete('mode', { path: '/' })
    staged = __scope()?.setCookies[0]
  })
  expect(staged).toContain('Max-Age=0')
  expect(staged).toContain('Path=/')
})

test('cookies.set inside a scope pushes to setCookies', () => {
  let staged: string[] = []
  runInRequestScope({}, () => {
    cookies.set('mode', 'dark', { path: '/' })
    staged = __scope()?.setCookies ?? []
  })
  expect(staged.length).toBe(1)
  expect(staged[0]).toContain('mode=dark')
})

test('cookies.set outside a scope is a no-op (no throw)', () => {
  expect(() => cookies.set('mode', 'dark')).not.toThrow()
})

test('cookies.get reads the request cookies', () => {
  runInRequestScope({ mode: 'dark' }, () => {
    expect(cookies.get('mode')).toBe('dark')
    expect(cookies.get('missing')).toBeUndefined()
  })
})

test('serializeCookie rejects an invalid cookie name (header-injection guard)', () => {
  expect(() => serializeCookie('bad name', 'v')).toThrow(/invalid cookie name/)
  expect(() => serializeCookie('a\r\nSet-Cookie: evil=1', 'v')).toThrow(/invalid cookie name/)
})

test('serializeCookie rejects CR/LF smuggled via an attribute', () => {
  // name/path/domain are not URL-encoded; a CRLF in path must not inject a header.
  expect(() => serializeCookie('mode', 'dark', { path: '/\r\nSet-Cookie: evil=1' })).toThrow(
    /CR\/LF/,
  )
})
