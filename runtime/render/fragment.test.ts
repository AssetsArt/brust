import { beforeEach, describe, expect, test } from 'bun:test'
import { createElement, Suspense } from 'react'
import { renderFragment } from './fragment.ts'
import { defineStore, signal } from '../store/index.ts'
import type { Signal } from '../store/index.ts'
import { cookies } from '../cookies.ts'
import { dedupe } from '../loader-cache.ts'
import { useNav } from '../navigation/react.ts'
import { __resetNavForTest } from '../navigation/store.ts'

// A test-controlled gate: a component throws `promise` (Suspense contract) until
// the test releases it — lets two renders overlap deterministically.
function makeGate() {
  let release: () => void = () => {}
  const promise = new Promise<void>((r) => {
    release = r
  })
  let done = false
  promise.then(() => {
    done = true
  })
  return { promise, release, isDone: () => done }
}
type Gate = ReturnType<typeof makeGate>

describe('renderFragment', () => {
  // renderFragment is server-side — it must exercise defineStore's per-call
  // AsyncLocalStorage branch. A sibling happy-dom test file in the same
  // `bun test` process may leak a global `window` (store/react.test.ts does),
  // and defineStore picks the branch at resolve()-time — force the server
  // branch here (same workaround as store/define-store.test.ts).
  beforeEach(() => {
    if (typeof (globalThis as Record<string, unknown>).window !== 'undefined') {
      ;(globalThis as Record<string, unknown>).window = undefined
    }
  })

  test('renders a component with props to an HTML string', async () => {
    function Hello({ name }: { name: string }) {
      return createElement('div', { className: 'greet' }, `hi ${name}`)
    }
    const html = await renderFragment(Hello, { name: 'dana' })
    expect(html).toBe('<div class="greet">hi dana</div>')
  })

  test('awaits Suspense boundaries — resolved content, not the fallback', async () => {
    const gate = makeGate()
    function Slow() {
      if (!gate.isDone()) throw gate.promise
      return createElement('span', null, 'late')
    }
    function Page() {
      return createElement(
        'div',
        null,
        createElement(
          Suspense,
          { fallback: createElement('em', null, 'loading') },
          createElement(Slow),
        ),
      )
    }
    const p = renderFragment(Page, {})
    gate.release()
    const html = await p
    expect(html).toContain('late')
    expect(html).not.toContain('loading')
  })

  test('CONCURRENT store isolation — two overlapping renders, same store, different seeds', async () => {
    // The store is module-level (as in real apps); each renderFragment call must
    // get its OWN per-call instance via AsyncLocalStorage, even while React's
    // renderToPipeableStream interleaves the two renders' work (the known
    // React/ALS escape pitfall — sequential isolation is NOT sufficient evidence).
    const isoStore = defineStore('fragment-iso-test', () => ({
      v: signal('unset'),
    }))
    function Seeder({ seed, gate }: { seed: string; gate: Gate }) {
      const store = isoStore() as { v: Signal<string> }
      // First pass: seed this render's instance, then suspend mid-render.
      if (store.v() === 'unset') store.v.set(seed)
      if (!gate.isDone()) throw gate.promise
      // Retry pass (after the OTHER render has started and seeded): re-read.
      // Cross-contamination would surface as the other render's seed here.
      return createElement('p', null, `seed=${store.v()}`)
    }
    function Page({ seed, gate }: { seed: string; gate: Gate }) {
      return createElement(Suspense, { fallback: null }, createElement(Seeder, { seed, gate }))
    }
    const gateA = makeGate()
    const gateB = makeGate()
    // Start A, then B — both seed their store and suspend before either resolves.
    const pA = renderFragment(Page, { seed: 'A', gate: gateA })
    const pB = renderFragment(Page, { seed: 'B', gate: gateB })
    // Let both first passes run (initial render work is scheduled per-request).
    await new Promise((r) => setTimeout(r, 10))
    // Release in reverse start order to maximize interleaving.
    gateB.release()
    gateA.release()
    const [htmlA, htmlB] = await Promise.all([pA, pB])
    expect(htmlA).toContain('seed=A')
    expect(htmlA).not.toContain('seed=B')
    expect(htmlB).toContain('seed=B')
    expect(htmlB).not.toContain('seed=A')
  })

  test('cookies passed via opts are readable through the cookies helper', async () => {
    function WhoAmI() {
      return createElement('span', null, cookies.get('user') ?? 'anonymous')
    }
    const html = await renderFragment(WhoAmI, {}, { cookies: { user: 'dana' } })
    expect(html).toContain('dana')
  })

  test('no cookies → empty scope (reader sees undefined, no throw)', async () => {
    function WhoAmI() {
      return createElement('span', null, cookies.get('user') ?? 'anonymous')
    }
    const html = await renderFragment(WhoAmI, {})
    expect(html).toContain('anonymous')
  })

  test('request cache is scoped per call (dedupe works inside, fresh across calls)', async () => {
    let calls = 0
    async function load(): Promise<number> {
      calls += 1
      return calls
    }
    function Loader() {
      // dedupe is request-scoped: two reads in ONE fragment share a call.
      dedupe('k', load)
      dedupe('k', load)
      return createElement('i', null, 'ok')
    }
    await renderFragment(Loader, {})
    expect(calls).toBe(1)
    await renderFragment(Loader, {})
    expect(calls).toBe(2) // fresh cache per call — no cross-call leakage
  })

  test('opts.path seeds useNav() — an island inside the fragment resolves active-nav', async () => {
    __resetNavForTest()
    function NavLink() {
      const { path, search } = useNav()
      return createElement(
        'a',
        { className: path === '/design' ? 'is-active' : 'idle', 'data-search': search },
        'x',
      )
    }
    const html = await renderFragment(NavLink, {}, { path: '/design', search: '?q=1' })
    expect(html).toContain('is-active')
    expect(html).toContain('data-search="?q=1"')
  })

  test('without opts.path, useNav() reports the idle default (context-free fragment)', async () => {
    __resetNavForTest()
    function NavLink() {
      const { path } = useNav()
      return createElement('a', { className: path === '/design' ? 'is-active' : 'idle' }, 'x')
    }
    const html = await renderFragment(NavLink, {})
    expect(html).toContain('class="idle"')
    expect(html).not.toContain('is-active')
  })

  test('rejects with the component error (no error-boundary semantics)', async () => {
    function Boom(): never {
      throw new Error('fragment boom')
    }
    await expect(renderFragment(Boom, {})).rejects.toThrow('fragment boom')
  })
})
