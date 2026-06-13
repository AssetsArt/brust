import { describe, expect, test } from 'bun:test'
import { __navInit, __resetNavForTest, getNavState } from './store.ts'
import { runInNavContext } from './server-context.ts'

// Importing server-context.ts installs the per-request resolver into store.ts
// via __setServerNavResolver. The resolver returns undefined when no nav scope
// is active, so getNavState() outside runInNavContext is unchanged (singleton).

describe('navigation/server-context — SSR request-scoped nav path', () => {
  test('getNavState() inside a nav scope returns the scoped path/search, phase idle', () => {
    __resetNavForTest()
    const s = runInNavContext('/design', '?q=1', () => getNavState())
    expect(s.path).toBe('/design')
    expect(s.search).toBe('?q=1')
    expect(s.phase).toBe('idle')
    expect(s.from).toBeNull()
    expect(s.to).toBeNull()
    expect(s.error).toBeNull()
  })

  test('canonicalizes the seeded path (strips trailing slash, root stays "/")', () => {
    expect(runInNavContext('/blog/', '', () => getNavState().path)).toBe('/blog')
    expect(runInNavContext('/', '', () => getNavState().path)).toBe('/')
  })

  test('referential stability: two reads in one scope return the SAME object', () => {
    // useSyncExternalStore's getServerSnapshot may be called more than once per
    // render; a fresh object each call trips "getSnapshot should be cached".
    const [a, b] = runInNavContext('/x', '', () => [getNavState(), getNavState()] as const)
    expect(a).toBe(b)
  })

  test('outside any nav scope, getNavState falls back to the singleton (idle)', () => {
    __resetNavForTest()
    expect(getNavState().path).toBe('')
  })

  test('scoped path WINS over the singleton (concurrent-request safety)', () => {
    __resetNavForTest()
    // The client-side singleton holds a different path (e.g. a prior __navInit).
    // The server scope must not read it — else request A's path would leak into
    // request B's SSR within the same worker.
    __navInit('/client-seeded', '')
    expect(runInNavContext('/server-req', '', () => getNavState().path)).toBe('/server-req')
    // ...and the singleton is untouched outside the scope.
    expect(getNavState().path).toBe('/client-seeded')
  })

  test('scopes are isolated — an inner scope never leaks into the outer', () => {
    const out = runInNavContext('/a', '', () => {
      const inner = runInNavContext('/b', '', () => getNavState().path)
      return { inner, afterInner: getNavState().path }
    })
    expect(out.inner).toBe('/b')
    expect(out.afterInner).toBe('/a')
  })

  test('the scope survives awaits (island/React SSR is async)', async () => {
    const path = await runInNavContext('/async', '', async () => {
      await Promise.resolve()
      await Promise.resolve()
      return getNavState().path
    })
    expect(path).toBe('/async')
  })
})
