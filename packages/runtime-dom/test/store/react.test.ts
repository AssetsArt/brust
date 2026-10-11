import { afterEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as React from 'react'
// react-dom/server, NOT react-dom/client: islands tests mock 'react-dom/client' process-wide, and a
// server render exercises useSyncExternalStore's server-snapshot path without a mounted root.
import { renderToString } from 'react-dom/server.node'
import { signal } from '../../src/signal'
import { defineStore } from '../../src/store/define-store'
import { __setServerResolver, _resetStores } from '../../src/store/registry'
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
  expect(renderToString(React.createElement(View))).toContain('>1</span>')
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
