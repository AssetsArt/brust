// L14 R14.3: with `__BRUST_DEV__` true the runtime exposes its live instances on `globalThis.__brustDev`; in a production
// build the define is false and none of it exists (the bundle test asserts the dead code is gone).
import { afterEach, expect, test } from 'bun:test'
import { Instance } from '../src/instance'

const g = globalThis as { __BRUST_DEV__?: boolean; __brustDev?: { instances: Set<Instance> } }
afterEach(() => {
  delete g.__BRUST_DEV__
  delete g.__brustDev
})
const host = () => ({}) as HTMLElement

test('dev: instances are tracked until disposed, children included', () => {
  g.__BRUST_DEV__ = true
  const parent = new Instance(host(), 'parentCmp', null, {})
  const child = new Instance(host(), 'childCmp', parent, {})
  expect([...(g.__brustDev?.instances ?? [])].map((i) => i.name)).toEqual(['parentCmp', 'childCmp'])
  child.dispose()
  expect([...(g.__brustDev?.instances ?? [])].map((i) => i.name)).toEqual(['parentCmp'])
  parent.dispose()
  expect(g.__brustDev?.instances.size).toBe(0)
})

test('production (the define is absent or false): nothing is exposed', () => {
  const i = new Instance(host(), 'cmp', null, {})
  expect(g.__brustDev).toBeUndefined()
  g.__BRUST_DEV__ = false
  new Instance(host(), 'cmp2', null, {})
  expect(g.__brustDev).toBeUndefined()
  i.dispose()
})
