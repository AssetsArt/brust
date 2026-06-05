import { test, expect } from 'bun:test'
import { createElement, type ReactNode } from 'react'
import { renderToString } from 'react-dom/server.node'
import { Island, IslandUsedContext, createIslandUsedBox, type IslandUsedBox } from './island.tsx'

// A stable named component for the island id.
function Widget() {
  return createElement('span', null, 'w')
}

function renderWith(box: IslandUsedBox, child: ReactNode): string {
  return renderToString(createElement(IslandUsedContext.Provider, { value: box }, child))
}

test('Island flips its own request-scoped box', () => {
  const box = createIslandUsedBox()
  renderWith(box, createElement(Island, { component: Widget }))
  expect(box.used).toBe(true)
})

test('a render with no Island leaves its box false', () => {
  const box = createIslandUsedBox()
  renderWith(box, createElement('div', null, 'no island'))
  expect(box.used).toBe(false)
})

test('two boxes do not cross-contaminate (the renderSlots>1 invariant)', () => {
  // Box A's tree uses an island; box B's does not. Rendered back-to-back sharing
  // the same module, each box must reflect ONLY its own tree — proving the signal
  // is request-scoped, not a shared module flag that a peer render could flip.
  const boxA = createIslandUsedBox()
  const boxB = createIslandUsedBox()
  renderWith(boxA, createElement(Island, { component: Widget }))
  renderWith(boxB, createElement('div', null, 'plain'))
  expect(boxA.used).toBe(true)
  expect(boxB.used).toBe(false)
})

test('Island without a Provider is a no-op, not a throw (standalone renderToString)', () => {
  const html = renderToString(createElement(Island, { component: Widget }))
  expect(html).toContain('data-brust-island="Widget"')
})
