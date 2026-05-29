import { createElement, type ComponentType, type ReactNode } from 'react'

/** Triggers that activate hydration of an island marker. */
export type HydrateTrigger = 'load' | 'idle' | 'visible' | 'interaction'

export interface IslandProps<P> {
  /** Component rendered server-side INSIDE the marker. Same component
   * the client chunk default-exports — SSR HTML must match the post-hydrate
   * tree to avoid React reconciliation warnings. Its `Component.name` is the
   * island id: it names the chunk (`<name>.js`) and the `data-brust-island`
   * marker the client bootstrap reads, so it must be a stable, named
   * component (no anonymous default export). */
  component: ComponentType<P>
  /** Props passed to the component on both server and client. Must be
   * JSON-serializable (no functions, classes, DOM nodes, etc.). */
  props: P
  /** When to hydrate. Default 'load'. */
  hydrate?: HydrateTrigger
}

/** Module-scope flag flipped by every `<Island>` render. `makeRenderer`
 * reads + resets it once per render to decide whether to prepend the
 * importmap + bootstrap script. */
let __used = false

/** Internal — flipped by Island, read by makeRenderer. */
export function consumeIslandUsedFlag(): boolean {
  const v = __used
  __used = false
  return v
}

export function Island<P extends Record<string, unknown>>({
  component: Component,
  props,
  hydrate = 'load',
}: IslandProps<P>): ReactNode {
  __used = true
  const resolvedId = Component.name
  if (!resolvedId) {
    throw new Error(
      '<Island> component has no `.name`; the island id is derived from ' +
        '`Component.name`. Use a stable named component (e.g. ' +
        '`export default function Counter() {…}`), not an anonymous default ' +
        'export or a minified/inlined function.',
    )
  }
  const propsJson = JSON.stringify(props)
  return createElement(
    'div',
    {
      'data-brust-island': resolvedId,
      'data-brust-props': propsJson,
      'data-brust-hydrate': hydrate,
    },
    createElement(Component, props),
  )
}
