import { expect, test } from 'bun:test'
import * as core from '@brust/core/store'
import * as coreReact from '@brust/core/store/react'
import * as rd from '@brust/runtime-dom/store'
import * as rdReact from '@brust/runtime-dom/store/react'
import { installServerResolver } from '../src/store/core-adapter'
import { getServerInstance } from '../src/store/server-context'
import { signal } from '@brust/runtime-dom/store'

const D1 = ['batch', 'computed', 'defineStore', 'effect', 'isComputed', 'isSignal', 'signal', 'untracked']

test('@brust/core/store re-exports the runtime-dom store by identity', () => {
  expect(Object.keys(core).sort()).toEqual(D1) // no __setServerResolver
  for (const k of D1) expect((core as Record<string, unknown>)[k]).toBe((rd as Record<string, unknown>)[k])
})

test('@brust/core/store/react re-exports useStore by identity', () => {
  expect(Object.keys(coreReact)).toEqual(['useStore'])
  expect(coreReact.useStore).toBe(rdReact.useStore)
})

test('two handles from @brust/core/store and @brust/runtime-dom/store share one store', () => {
  // R4: without a server resolver the browser registry needs a `document`; this package's tests have no
  // happy-dom preload, so install the smallest stand-in (no seed tags) for the duration.
  const g = globalThis as { document?: unknown }
  const prev = g.document
  g.document = { querySelectorAll: () => [] }
  // other test files import worker.ts, which installs the server resolver process-wide: lift it for this case
  installServerResolver(null)
  try {
    const f = () => ({ n: signal(0) })
    const a = core.defineStore('x-core', f)
    const b = rd.defineStore('x-core', f)
    a.n.set(7)
    expect(b.n()).toBe(7)
  } finally {
    installServerResolver(getServerInstance)
    if (prev === undefined) delete g.document
    else g.document = prev
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('brust.stores')]
  }
})
