import { expect, test } from 'bun:test'
import { join } from 'node:path'
import * as index from '../../src/index'
import * as store from '../../src/store/index'

const D1 = ['batch', 'computed', 'defineStore', 'effect', 'isComputed', 'isSignal', 'signal', 'untracked']

test('@brust/runtime-dom/store exports exactly the D1 values', async () => {
  expect(Object.keys(await import('@brust/runtime-dom/store')).sort()).toEqual(D1)
  expect(Object.keys(store).sort()).toEqual(D1)
})

test('the runtime entry re-exports every D1 value by identity', () => {
  for (const k of D1) expect((index as Record<string, unknown>)[k]).toBe((store as Record<string, unknown>)[k])
})

test('@brust/runtime-dom/store/react exports useStore', async () => {
  const r = await import('@brust/runtime-dom/store/react')
  expect(typeof r.useStore).toBe('function')
})

test('@brust/runtime-dom/store/internal exports the server hook and helpers', async () => {
  const i = await import('@brust/runtime-dom/store/internal')
  for (const k of ['__setServerResolver', 'applyStoreSnapshot', 'hydrateRecord', 'toScriptJson', 'storeScriptTag', 'parseStoreScript'])
    expect(typeof (i as Record<string, unknown>)[k]).toBe('function')
})

test('the runtime entry does not reach react', async () => {
  const out = await Bun.build({ entrypoints: [join(import.meta.dir, '../../src/index.ts')], external: ['react'], target: 'browser' })
  expect(out.success).toBe(true)
  const text = await out.outputs[0]!.text()
  expect(/from\s*["']react|require\(["']react/.test(text)).toBe(false)
})
