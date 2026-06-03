// runtime/navigation/store.test.ts
import { test, expect, beforeEach } from 'bun:test'
import {
  nav,
  getNavState,
  subscribe,
  onBeforeNavigate,
  onNavigate,
  onNavigateError,
  __navStart,
  __navCommit,
  __navError,
  __navInit,
  __resetNavForTest,
} from './store.ts'

beforeEach(() => __resetNavForTest())

test('__navInit sets path/search, idle phase, null from/to/error', () => {
  __navInit('/a', '?x=1')
  expect(getNavState()).toEqual({
    path: '/a',
    search: '?x=1',
    phase: 'idle',
    error: null,
    from: null,
    to: null,
  })
})

test('__navStart sets loading, from=current path, to=target, fires onBeforeNavigate', () => {
  __navInit('/a', '')
  const seen: Array<{ from: string; to: string }> = []
  onBeforeNavigate((e) => seen.push(e))
  __navStart('/b', '?q=1')
  const s = getNavState()
  expect(s.phase).toBe('loading')
  expect(s.from).toBe('/a')
  expect(s.to).toBe('/b')
  expect(seen).toEqual([{ from: '/a', to: '/b' }])
})

test('__navCommit commits path/search, success phase, clears to, fires onNavigate', () => {
  __navInit('/a', '')
  __navStart('/b', '?q=1')
  const seen: Array<string> = []
  onNavigate((e) => seen.push(e.path))
  __navCommit('/b', '?q=1')
  const s = getNavState()
  expect(s.path).toBe('/b')
  expect(s.search).toBe('?q=1')
  expect(s.phase).toBe('success')
  expect(s.to).toBe(null)
  expect(s.error).toBe(null)
  expect(seen).toEqual(['/b'])
})

test('__navError sets error phase + error, clears to, fires onNavigateError', () => {
  __navInit('/a', '')
  __navStart('/b', '')
  const seen: Array<{ to: string; error: Error }> = []
  onNavigateError((e) => seen.push(e))
  const err = new Error('boom')
  __navError('/b', err)
  const s = getNavState()
  expect(s.phase).toBe('error')
  expect(s.error).toBe(err)
  expect(s.to).toBe(null)
  expect(seen).toEqual([{ to: '/b', error: err }])
})

test('subscribe fires on each transition and unsubscribes', () => {
  __navInit('/a', '')
  const phases: string[] = []
  const unsub = subscribe((s) => phases.push(s.phase))
  __navStart('/b', '')
  __navCommit('/b', '')
  unsub()
  __navStart('/c', '')
  expect(phases).toEqual(['loading', 'success']) // no third entry after unsub
})

test('nav signals are the shared singleton (reactive reads)', () => {
  __navInit('/a', '')
  expect(nav.path()).toBe('/a')
  __navCommit('/z', '')
  expect(nav.path()).toBe('/z')
})

test('onBeforeNavigate unsubscribe stops delivery', () => {
  __navInit('/a', '')
  let n = 0
  const off = onBeforeNavigate(() => {
    n++
  })
  __navStart('/b', '')
  off()
  __navStart('/c', '')
  expect(n).toBe(1)
})
