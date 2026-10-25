import { afterEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as React from 'react'
// react-dom/server, NOT react-dom/client: islands tests mock 'react-dom/client' process-wide, and a
// server render exercises useSyncExternalStore's server-snapshot path without a mounted root.
import { hydrateRoot } from 'react-dom/client'
import { renderToString } from 'react-dom/server.node'
import { computed, signal } from '../../src/signal'
import { defineStore } from '../../src/store/define-store'
import { __setServerResolver, _resetStores, applyStoreSnapshot } from '../../src/store/registry'
import { useStore } from '../../src/store/react'

afterEach(() => {
  __setServerResolver(null)
  _resetStores()
})

test('useStore renders the store snapshot and reflects writes; server snapshot matches', () => {
  const team = defineStore('rt-team', () => {
    const score = signal(0)
    return { score, bump() { score.set((v) => v + 1) } }
  })
  function View() {
    const snap = useStore(team)
    return React.createElement('span', { id: 'score' }, String(snap.score))
  }
  expect(renderToString(React.createElement(View))).toContain('>0</span>')
  expect(team.snapshot().score).toBe(0)
  team.bump()
  // The server snapshot is the SSR one (G13): a write after load does not change what hydration expects.
  expect(renderToString(React.createElement(View))).toContain('>0</span>')
  expect(team.snapshot().score).toBe(1)
})

test('useStore during SSR outside a request scope renders {} instead of throwing', () => {
  __setServerResolver((name) => {
    throw new Error(`store '${name}' accessed outside a request scope`)
  })
  const s = defineStore('rt-scope', () => ({ n: signal(1) }))
  function View() {
    const snap = useStore(s) as { n?: number }
    return React.createElement('b', null, String(snap.n))
  }
  expect(renderToString(React.createElement(View))).toBe('<b>undefined</b>')
})

test('react.ts has no value import from the core', () => {
  const src = readFileSync(join(import.meta.dir, '../../src/store/react.ts'), 'utf8')
  const rel = src.split('\n').filter((l) => /from '\.\.?\//.test(l))
  expect(rel.length).toBeGreaterThan(0)
  for (const l of rel) expect(l.trimStart().startsWith('import type')).toBe(true)
})

// G13: a native mount effect writes the store before an island hydrates. The island must hydrate against the
// snapshot the server rendered (then catch up with the live value), not the live one: React #418 otherwise.
function seeded(name: string, state: object) {
  document.body.innerHTML = `<script type="application/json" data-brust-store="${name}">${JSON.stringify(state)}</script><div id="root"></div>`
  return document.getElementById('root') as HTMLElement
}
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 10))
}

test('hydrateRoot after a store write hydrates the SSR value without recoverable errors, then shows the live one', async () => {
  const store = defineStore('rt-hydrate', () => {
    const score = signal(0)
    return { score }
  })
  const root = seeded('rt-hydrate', { score: 5 })
  root.innerHTML = '<span id="score">5</span>' // what the server rendered from the seed
  function View() {
    return React.createElement('span', { id: 'score' }, String(useStore(store).score))
  }
  expect(store.score()).toBe(5) // first access seeds from the script tag
  store.score.set(9) // the native mount effect, before idle hydration
  const errors: unknown[] = []
  hydrateRoot(root, React.createElement(View), { onRecoverableError: (e) => errors.push(e) })
  await until(() => root.textContent === '9')
  expect(errors).toEqual([])
  expect(root.textContent).toBe('9')
})

test('the ssr snapshot includes computeds, is identity-stable, and ignores later writes', () => {
  const s = defineStore('rt-ssr-id', () => {
    const n = signal(1)
    return { n, double: computed(() => n() * 2) }
  })
  seeded('rt-ssr-id', { n: 3 })
  const ssr = (s as unknown as Record<symbol, () => { n: number; double: number }>)[Symbol.for('brust.ssrSnapshot')]!
  const first = ssr()
  expect(first).toEqual({ n: 3, double: 6 })
  expect(ssr()).toBe(first)
  expect(s.snapshot()).toBe(first) // reused as rec.snap until the first write
  s.n.set(4)
  expect(ssr()).toBe(first)
  expect(s.snapshot()).toEqual({ n: 4, double: 8 })
})

test('applyStoreSnapshot refreshes the ssr snapshot (R11.1)', () => {
  const s = defineStore('rt-ssr-nav', () => ({ n: signal(0) }))
  seeded('rt-ssr-nav', { n: 1 })
  const ssr = (s as unknown as Record<symbol, () => { n: number }>)[Symbol.for('brust.ssrSnapshot')]!
  expect(ssr().n).toBe(1)
  applyStoreSnapshot({ 'rt-ssr-nav': { n: 7 } })
  expect(ssr().n).toBe(7)
})

test('an island on a page swapped in later hydrates against that page\'s seed tag, not the first page\'s (F461)', () => {
  const s = defineStore('rt-ssr-swap', () => {
    const url = signal('/')
    return { url, upper: computed(() => url().toUpperCase()) }
  })
  seeded('rt-ssr-swap', { url: '/a' })
  const ssr = (s as unknown as Record<symbol, () => { url: string; upper: string }>)[Symbol.for('brust.ssrSnapshot')]!
  const first = ssr()
  expect(first).toEqual({ url: '/a', upper: '/A' })
  // A navigation: page B's body (and its tag) replaces page A's; the store is live and keeps its client value.
  s.url.set('/client')
  document.body.innerHTML = '<script type="application/json" data-brust-store="rt-ssr-swap">{"url":"/b"}</script>'
  const second = ssr()
  expect(second.url).toBe('/b')
  expect(ssr()).toBe(second) // identity-stable for React
  expect(s.snapshot().url).toBe('/client') // the live value is untouched
  // The same tag read again is the same snapshot; a page without a tag falls back to the first one.
  document.body.innerHTML = ''
  expect(ssr()).toBe(first)
})
