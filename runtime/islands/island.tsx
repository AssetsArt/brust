import { createElement, type ComponentType, type ReactNode } from 'react'
import type { IsrConfig } from './isr-jsx.ts'

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
   * JSON-serializable (no functions, classes, DOM nodes, etc.). Optional — a
   * propless island (e.g. one that reads only global/client state) may omit it;
   * it defaults to `{}`. On native routes, omitting `props` lowers to an empty
   * props_path the renderer fills with `{}`. */
  props?: P
  /** When to hydrate. Default 'load'. */
  hydrate?: HydrateTrigger
  /** Native routes only: render this island server-side (renderToString during
   * the loader crossing) so its markup ships in the HTML, then hydrate. Ignored
   * on the React path (the whole tree already SSRs there). Default false. */
  ssr?: boolean
  /**
   * Optional ISR (incremental static regeneration) cache for an `ssr` island on
   * a native-jinja route. When present, the island's `renderToString` runs ONCE
   * per `key`; later requests serve the frozen markup from the Rust-side cache.
   * Ignored unless `ssr` is set (caching a client-only island is meaningless).
   *
   * - `key` (required): unique string identifying this cache entry. A different
   *   key is a different cached render. Compute it in the loader and pass it
   *   through, e.g. `isr={{ key: data.cacheKey }}`.
   * - `tags` (optional): groups for bulk invalidation —
   *   `import { cache } from 'brustjs'; cache.invalidate({ tags: ['blog'] })`
   *   evicts every entry carrying that tag. `cache.invalidate({ key })` evicts one.
   * - `revalidate` (optional): TTL in **seconds** (integer). Omit to cache until
   *   explicitly invalidated.
   *
   * Example: `isr={{ key: data.cacheKey, tags: ['blog'], revalidate: 60 }}`
   */
  isr?: IsrConfig
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

// Constraint is `object`, NOT `Record<string, unknown>`: a TS `interface` has no
// implicit index signature, so it does NOT satisfy `extends Record<string, unknown>`
// — that made `P` fall back to the constraint and rejected any component whose
// props are declared as an interface (`<Island component={C} props={p} />` →
// ts(2322)). `extends object` accepts interfaces, still rejects primitives, and
// lets `P` infer from `component`/`props` so the two stay type-tied.
export function Island<P extends object>({
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
  const resolvedProps = (props ?? {}) as P
  const propsJson = JSON.stringify(resolvedProps)
  return createElement(
    'div',
    {
      'data-brust-island': resolvedId,
      'data-brust-props': propsJson,
      'data-brust-hydrate': hydrate,
    },
    createElement(Component, resolvedProps),
  )
}
