import { createElement, type ComponentType, type ReactNode } from 'react'

/** Triggers that activate hydration of an island marker. */
export type HydrateTrigger = 'load' | 'idle' | 'visible' | 'interaction'

export interface IslandProps<P> {
  /** Stable id — must match a key in the user's island.config.ts so the
   * client bootstrap can resolve the chunk URL `/_brust/islands/<id>.js`.
   * If omitted, falls back to `component.name`. Pass an explicit `id`
   * when running a build that mangles function names. */
  id?: string
  /** Component rendered server-side INSIDE the marker. Same component
   * the client chunk default-exports — SSR HTML must match the post-hydrate
   * tree to avoid React reconciliation warnings. */
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
  id,
  component: Component,
  props,
  hydrate = 'load',
}: IslandProps<P>): ReactNode {
  __used = true
  const resolvedId = id ?? Component.name
  if (!resolvedId) {
    throw new Error(
      '<Island> requires an `id` prop because the component has no `.name` ' +
      '(anonymous default export or minified function). Pass id="..." explicitly.',
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
