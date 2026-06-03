import { expect, test } from 'bun:test'
import { getRequestContext, runInRequestScope } from './request-context.ts'
import { runInStoreContext } from './store/server-context.ts'

test('getRequestContext returns a per-scope Map', () => {
  runInRequestScope({}, () => {
    const ctx = getRequestContext()
    expect(ctx).toBeInstanceOf(Map)
    ctx.set('user', 42)
    expect(getRequestContext().get('user')).toBe(42)
  })
})

test('two runInRequestScope are isolated', () => {
  runInRequestScope({}, () => {
    getRequestContext().set('a', 1)
    expect(getRequestContext().has('a')).toBe(true)
  })
  runInRequestScope({}, () => {
    // Fresh scope — no leakage from the previous one.
    expect(getRequestContext().has('a')).toBe(false)
  })
})

test('getRequestContext throws outside any scope', () => {
  expect(() => getRequestContext()).toThrow(/outside a request scope/)
})

test('nested inside runInStoreContext both work', () => {
  runInStoreContext(() => {
    runInRequestScope({}, () => {
      const ctx = getRequestContext()
      ctx.set('nested', 'yes')
      expect(getRequestContext().get('nested')).toBe('yes')
    })
  })
})
