import { test, expect } from 'bun:test'
import { createElement, type ReactNode } from 'react'
import { renderToString } from 'react-dom/server.node'
import {
  configureIslandIdRegistry,
  Island,
  IslandUsedContext,
  createIslandUsedBox,
  type IslandUsedBox,
} from './island.tsx'

// A stable named component for the island id.
function Widget() {
  return createElement('span', null, 'w')
}

function MenuSkeleton() {
  return createElement('span', null, 'loading menu')
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

test('React-path Island accepts fallback but renders only the real component', () => {
  const html = renderToString(
    createElement(Island, {
      component: Widget,
      fallback: createElement(MenuSkeleton),
    }),
  )
  expect(html).toContain('>w</span>')
  expect(html).not.toContain('loading menu')
})

test('registry maps same-name components from different files to distinct marker ids', () => {
  // Two distinct function identities both named "Counter" (≈ two source files).
  const A = function Counter() {
    return createElement('span', null, 'a')
  }
  const B = { Counter: () => createElement('span', null, 'b') }.Counter
  // The worker seeds this from _island-sources.json (Component fn → unique id).
  configureIslandIdRegistry([
    [A, 'Counter_aaaaaaaa'],
    [B, 'Counter_bbbbbbbb'],
  ])
  const box = createIslandUsedBox()
  const a = renderWith(box, createElement(Island, { component: A }))
  const b = renderWith(box, createElement(Island, { component: B }))
  // Same name, distinct identities → distinct content-addressed markers.
  expect(a).toContain('data-brust-island="Counter_aaaaaaaa"')
  expect(b).toContain('data-brust-island="Counter_bbbbbbbb"')
  // Unknown component → falls back to Component.name.
  function Lonely() {
    return null
  }
  const c = renderWith(box, createElement(Island, { component: Lonely }))
  expect(c).toContain('data-brust-island="Lonely"')
  configureIslandIdRegistry([]) // reset for other tests
})
