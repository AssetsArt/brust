import { afterEach, expect, test } from 'bun:test'
import { clearNavigationCache as browserClear, navigate as browserNavigate } from '../src/navigate-browser'
import { clearNavigationCache as serverClear, navigate as serverNavigate } from '../src/navigate'

const g = globalThis as Record<symbol | string, unknown>
const KEY = Symbol.for('brust.nav')
const hadLocation = 'location' in g
const prevLocation = g.location
afterEach(() => {
  delete g[KEY]
  if (hadLocation) g.location = prevLocation
  else delete g.location
})

test('bridge present: same flow, resolves after the bridge settles', async () => {
  const calls: unknown[][] = []
  let settle!: () => void
  g[KEY] = { navigate: (...a: unknown[]) => (calls.push(a), new Promise<void>((r) => (settle = r))) }
  let done = false
  const p = browserNavigate('/next', { replace: true }).then(() => (done = true))
  await Promise.resolve()
  expect(calls).toEqual([['/next', { replace: true }]])
  expect(done).toBe(false)
  settle()
  await p
  expect(done).toBe(true)
})

test('bridge absent: a full load (assign, or replace)', async () => {
  const seen: string[] = []
  g.location = { assign: (u: string) => seen.push('assign ' + u), replace: (u: string) => seen.push('replace ' + u) }
  await browserNavigate('/a')
  await browserNavigate('/b', { replace: true })
  expect(seen).toEqual(['assign /a', 'replace /b'])
})

test('server entry throws "navigate is browser-only"', () => {
  expect(() => serverNavigate('/x')).toThrow(/navigate is browser-only/)
})

test('clearNavigationCache: the bridge clears its page cache; without nav, and on the server, a no-op', () => {
  let n = 0
  browserClear()
  g[KEY] = { navigate: () => Promise.resolve(), clearCache: () => n++ }
  browserClear()
  expect(n).toBe(1)
  expect(serverClear()).toBeUndefined()
})
