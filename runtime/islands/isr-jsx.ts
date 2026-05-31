// ISR config type + a global JSX augmentation that makes the `isr` attribute
// accept-anywhere, the way React's built-in `key`/`ref` work.
//
// `isr` is a brust COMPILER attribute: the JSX compiler reads it at lower time
// and strips it (it never reaches the component at runtime — the generated
// factory contains no `isr` prop). So, like `key`, it is not part of any
// component's own props type. Without this augmentation TypeScript would reject
// `<MyLayout isr={{ … }}>` because the user's `MyLayout` props don't declare
// `isr`. Augmenting `React.Attributes` (where `key` lives) makes `isr` valid on
// every element/component with zero per-component boilerplate.
//
// This file must stay in the package's type import graph (it is re-exported
// from `runtime/index.ts` and consumed by `island.tsx`) so the augmentation is
// in scope for any project that imports from `brustjs`.

/** Shape of the `isr` attribute on an SSR component or `ssr` island on a
 * native-jinja route. `renderToString` runs ONCE per `key`; later same-key
 * requests serve the frozen markup from the Rust-side cache. */
export interface IsrConfig {
  /** Required unique cache key. A different key is a different cached render.
   * Compute it in the loader and pass it through (e.g. `data.cacheKey`). */
  key: string
  /** Optional groups for bulk invalidation —
   * `import { cache } from 'brustjs'; cache.invalidate({ tags: ['blog'] })`
   * evicts every entry carrying a tag. `cache.invalidate({ key })` evicts one. */
  tags?: string[]
  /** Optional TTL in SECONDS (integer). Omit to cache until invalidated. */
  revalidate?: number
}

// Augment `React.JSX.IntrinsicAttributes` — the interface the `react-jsx`
// transform consults for props allowed on EVERY element/component (it is where
// `key` lives, via `IntrinsicAttributes extends React.Attributes`). Targeting it
// directly is the form that actually merges under React 19's `export = React`
// types; augmenting `React.Attributes` does not propagate through the export-=
// module boundary.
declare module 'react' {
  namespace JSX {
    interface IntrinsicAttributes {
      /** brust ISR cache directive — compiler-consumed (stripped before the
       * component is called), valid on any SSR component or `ssr` island on a
       * native route. See {@link IsrConfig}. */
      isr?: IsrConfig
      /** brust `native` inline directive — compiler-consumed (stripped at lower
       * time). On a native-jinja route, `<Comp native />` expands the component
       * inline at compile time (no JS-worker render) when it is pure
       * (props→JSX, no hooks/side-effects); otherwise it degrades to a normal
       * SSR component with a build warning. Bare boolean, like `ssr` on an
       * island. */
      native?: boolean
    }
  }
}
