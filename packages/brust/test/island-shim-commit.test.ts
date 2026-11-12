// F545: every island entry renders its root inside `__Commit`, whose layout effect calls the runtime's `committed`
// (3rd arg of the hydrate fn), on both the hydrateRoot path and the client_only createRoot one. Served:
// tests/server/island-committed.chromium.test.ts.
import { expect, test } from 'bun:test'
import { islandShim } from '../src/build/bundle'
import type { Compiled } from '../src/build/compile'

const island = (React: Record<string, unknown>) => ({ id: 'box_1', file: '/app/box.tsx', ir: { tier: { React }, export: 'Box' } }) as unknown as Compiled

test.each([
  ['hydrateRoot', {}, 'hydrateRoot(host, createElement(__Commit, { done: committed }, createElement(Comp, props)),'],
  ['createRoot', { client_only: true }, 'root.render(createElement(__Commit, { done: committed }, createElement(Comp, props)))'],
])('%s: the root renders inside __Commit, which signals from a layout effect', (_api, react, call) => {
  const shim = islandShim(island(react))
  expect(shim).toContain(call)
  expect(shim).toContain("import { createElement, useLayoutEffect } from 'react'")
  expect(shim).toContain('const __Commit = ({ done, children }: any) => { useLayoutEffect(() => { done?.() }, []); return children }')
  expect(shim).toContain('(host: Element, props: any, committed?: () => void) =>')
})
