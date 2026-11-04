import { describe, expect, test } from 'bun:test'
import { canonical, hasStoreWork, keys } from '../src/keys'

describe('keys', () => {
  const k = keys('ns')
  test('shapes carry the hash tag', () => {
    expect(k.page('ns:b1:p:ab')).toBe('{brust:ns}:page:ns:b1:p:ab')
    expect(k.tag('items')).toBe('{brust:ns}:tag:items')
    expect(k.path(undefined, '/x')).toBe('{brust:ns}:path:GET /x')
    expect(k.path('post', '/x')).toBe('{brust:ns}:path:POST /x')
    expect(k.markTag('items')).toBe('{brust:ns}:inval:tag:items')
    expect(k.markPath('get', '/x')).toBe('{brust:ns}:inval:path:GET /x')
    expect(k.seq).toBe('{brust:ns}:seq')
    expect(k.stage('u')).toBe('{brust:ns}:stage:u')
    expect(k.channel).toBe('brust:ns:inval')
    // F493: the prefix is JSON-quoted, so a host with a port or a colon stays one name part.
    expect(k.pfx('a.test:8080')).toBe('{brust:ns}:pfx:"a.test:8080"')
    expect(k.pfx('')).toBe('{brust:ns}:pfx:""')
    expect(k.markPfx('a.test')).toBe('{brust:ns}:inval:pfx:"a.test"')
  })
  test('canonical keeps prefix apart (F493)', () => {
    expect(canonical({ prefix: 'a.test', path: '/x' })).not.toBe(canonical({ path: '/x' }))
    expect(canonical({ prefix: 'a.test', path: '/x' })).not.toBe(canonical({ prefix: 'b.test', path: '/x' }))
    expect(canonical({ prefix: '' })).not.toBe(canonical({}))
    expect(canonical({ prefix: 'a.test', method: 'post' })).toBe(canonical({ prefix: 'a.test', method: 'POST' }))
    expect(canonical({ prefix: 'a.test', method: 'POST' })).not.toBe(canonical({ prefix: 'a.test' }))
    expect(hasStoreWork({ prefix: 'a.test' })).toBe(true)
  })
  test('canonical ignores tag order, duplicates and method case', () => {
    expect(canonical({ tags: ['b', 'a'], path: '/x' })).toBe(canonical({ path: '/x', method: 'get', tags: ['a', 'b', 'a'] }))
    expect(canonical({ tags: ['a'] })).not.toBe(canonical({ tags: ['b'] }))
  })
  test('key-only args have no store work', () => {
    expect(hasStoreWork({ key: 'k' })).toBe(false)
    expect(hasStoreWork({ tags: [] })).toBe(false)
    expect(hasStoreWork({ tags: ['a'] })).toBe(true)
    expect(hasStoreWork({ path: '/' })).toBe(true)
  })
})
