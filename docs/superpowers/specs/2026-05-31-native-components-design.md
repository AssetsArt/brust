# Native page components — non-Island components on native routes

**Status:** spec — brainstormed 2026-05-31; ready for plan
**Date:** 2026-05-31

## Goal

Native (`native: true`) routes compile TSX → Jinja and render Rust-side, bypassing
React on the hot path. Currently the compiler (`jsx-rust-compiler`) rejects every
capitalized component that is not `<Island>` or `<BrustPage>` with
`CustomComponentNotSupported`. This prevents code reuse: a `<Layout>` wrapper, a
`<Card>`, a `<StaticNav>` — all unavailable on native routes today.

This spec adds **two modes** for non-Island components in native pages:

| Mode | Syntax | When to use |
|---|---|---|
| **SSR** (default) | `<Layout title={x}>` | component uses React features (constants, .map, hooks at SSR level); worker `renderToString`, no client JS |
| **native inline** (opt-in) | `<StaticNav native />` | pure JSX, no module constants or hooks; compiler inlines to Jinja at build time, zero request-time cost |

Neither mode affects `<Island>` (which owns its own `ssr` / `isr` semantics) or
`<BrustPage>` (native document shell, unchanged).

## Non-goals

- Components with hooks / `useState` on the `native` inline path — those must use SSR (default) or `<Island>`.
- ISR caching of SSR component output (possible future: cache whole `comp_N_html`).
- `native` inline of components that import other packages (only own-project relative imports supported v1).
- Hot-reload of inlined `native` components on `.tsx` edit (same deferred status as native-page hot-reload).

## Behaviour rules

### SSR component (default)

Any capitalized tag in a native page that is not `<Island>` or `<BrustPage>` is an
**SSR component**. The compiler emits a `{{ comp_N_html | safe }}` slot in the Jinja
template. At request time the JS worker renders the component (and its entire React
subtree, including any `<Island>` children) via `renderToString` in one call, and
fills the slot.

```tsx
// Page.tsx (native: true)
<Layout title={greeting}>
  <h1>{greeting}</h1>
  <Island component={Counter} props={data.counter} hydrate="load" />
  <Island component={Counter} props={data.counter} hydrate="load" ssr />
</Layout>
```

- `<Layout>` SSR renders server-side; client gets static HTML for the shell.
- `<Island>` tags inside children: Island.tsx React-path render creates
  `data-brust-*` markers + SSR HTML inside `renderToString`. Client bootstrap
  hydrates them as normal.
- `<Island ssr>` / `<Island isr>` inside SSR component children: ISR cache does
  **not** apply (island is embedded in `comp_N_html`, not rendered separately).
- Sub-components inside `<Layout>` (the component file itself): no annotation
  needed — React's `renderToString` handles the whole tree normally.

### `native` inline component

Adding `native` to a component call opts into compile-time Jinja inlining:

```tsx
<StaticNav title={greeting} native />
<StaticCard label={data.label} native>
  <p>static child</p>
</StaticCard>
```

Rules inside a `native` component (applied recursively when compiler reads its source):
- Sub-component with `native` → recursively inline.
- Sub-component without annotation → **auto-fallback to SSR slot** (no compile error).
  Props are re-expressed in page scope via the accumulated substitution map.
- `<Island>` → Island marker emitted in Jinja (existing behaviour).
- Any compiler-unsupported feature (multi-statement body, module constants, hooks) →
  compiler error: *"component uses features not supported in native inline — remove
  `native` to use SSR fallback"*.
- Circular inline (A→B→A) → compiler error: *"circular native component inline"*.
- Import not resolvable (source not in `componentSources`) → warning + auto-fallback
  to SSR slot (same as unannotated sub-component).

`native` on `<Island>` → ignored silently (no-op).

### Children

- **SSR component with children**: children are part of the React element tree
  passed to the factory function; worker renders everything in one `renderToString` call.
- **`native` component with children**: `{children}` in the component source is
  substituted with the call-site child nodes during IR prop substitution.

## Architecture

### Build time

#### 1. Rust compiler — new IR node + emitters

`lower_element` gains a third recognition path (after `<Island>` and `<BrustPage>`):
capitalized ident that is not those two → `JsxNode::SsrComponent { component, props, children }`.

`native` attribute present → recursive inline via prop substitution (see below).

Two new emitters run alongside `emit_jinja`:

- **`emit_jinja`** (extended): `JsxNode::SsrComponent` → `{{ comp_N_html | safe }}`.
- **`emit_factory`** (new): walks the IR and emits a `(ctx) => h(Component, props, ...children)`
  TypeScript expression for every `SsrComponent` node. Expressions map:
  `Expr::Field("x")` → `ctx.x`, `Expr::MemberAccess("a","b")` → `ctx.a.b`,
  `JsxNode::Island` → `h(Island, { component: X, props: ctx.path, hydrate, ssr })`.

NAPI interface change:
```typescript
compileJsx(
  source: string,
  path: string,
  componentSources?: Record<string, string>   // name → source, for native inline
) → { template: string; islandsJson: string; componentsJson: string }
```

`componentsJson` is a JSON array of component manifest entries (see below).

#### 2. Prop substitution (native inline path)

When the compiler encounters `<StaticNav title={greeting} native>children</StaticNav>`:

1. Parse StaticNav source → `Component` IR with params `{ title, children, … }`.
2. Build substitution map from call-site attrs:
   - string literal `label="foo"` → `Expr::StaticText("foo")`
   - expression `title={greeting}` → `Expr::Field("greeting")` (from parent scope)
   - member `count={data.total}` → `Expr::MemberAccess { root:"data", path:["total"] }`
   - children → `Vec<JsxNode>` (call-site child nodes)
3. Walk StaticNav IR replacing scalar props. For `{children}`: the lowerer emits a
   `JsxNode::ChildrenSlot` when it sees `{children}` inside a component being inlined;
   the substitution pass replaces every `ChildrenSlot` with the call-site child nodes
   (spliced in-place). `ChildrenSlot` is an IR-internal node, never emitted to Jinja.
4. Inline the substituted tree into the parent IR in-place.

Sub-components encountered during inline walk:
- `<SubComp native>` → recurse (load SubComp source from `componentSources`).
- `<SubComp>` (no attr) → emit `{{ comp_N_html | safe }}` + add manifest entry;
  SubComp's props are re-expressed in page scope via the current substitution map.

#### 3. TS build step — `emitNativeTemplates` additions

- Before calling `compileJsx`, `scanImports` reads all component sources reachable
  from the page file and populates `componentSources` (for `native` inline).
- After `compileJsx`, reads `componentsJson` and:
  - Writes `<Name>.components.json` (enriched with absolute `sourcePath`s, same
    pattern as `reconcileIslandManifest` for islands).
  - Generates `<Name>.factory.ts` in `.brust/jinja/`:

```typescript
// NativeIslands.factory.ts (auto-generated, do not edit)
import Layout from '/abs/path/components/Layout.tsx'
import Counter from '/abs/path/components/Counter.tsx'
import { Island } from 'brustjs'
import { createElement as h } from 'react'

export const factories = [
  // comp_0
  (ctx: any) => h(Layout, { title: ctx.greeting },
    h('h1', null, ctx.greeting),
    h(Island, { component: Counter, props: ctx.data.counter, hydrate: 'load' }),
    h(Island, { component: Counter, props: ctx.data.counter, hydrate: 'load', ssr: true }),
  ),
]
```

### Request time

#### 4. Worker — `resolveComponentContext` (new, `native-render.ts`)

Analogous to `resolveIslandContext`. For each manifest entry:

- **Leaf (no children)**: `renderToString(createElement(Component, buildProps(entry, data)))`.
- **With children**: import the route's `.factory.ts`, call `factories[entry.instance](data)`,
  `renderToString` the result. Island.tsx React-path render creates `data-brust-*`
  markers + SSR HTML inside the same call.

On `renderToString` failure: contained failure — degrade to empty string + `console.error`,
same invariant as SSR islands.

#### 5. `routes.ts` — native branch

```typescript
const [islandExtra, componentExtra] = await Promise.all([
  manifest?.length ? resolveIslandContext(manifest, rt, islandCache) : {},
  compManifest?.length ? resolveComponentContext(compManifest, rt, templateName) : {},
])
const ctx = { ...rt, ...islandExtra, ...componentExtra }
```

Both resolutions run concurrently. Context shape unchanged from Jinja's perspective:
new keys `comp_N_html` are just additional template variables.

#### 6. Rust server — unchanged

`jinja.rs` renders `{{ comp_N_html | safe }}` identically to `{{ island_N_html | safe }}`.
No Rust changes required.

## File changes summary

| File | Change |
|---|---|
| `crates/jsx-rust-compiler/src/ir.rs` | add `JsxNode::SsrComponent`, `JsxNode::ChildrenSlot` |
| `crates/jsx-rust-compiler/src/lower.rs` | recognise non-Island/BrustPage capitalised tags; `native` prop → inline path |
| `crates/jsx-rust-compiler/src/emit_jinja.rs` | emit `{{ comp_N_html \| safe }}` for `SsrComponent` |
| `crates/jsx-rust-compiler/src/emit_factory.rs` | **new** — IR → `(ctx) => h(…)` TS expression |
| `crates/jsx-rust-compiler/src/lib.rs` | expose `componentsJson` from `compile_full`; add `componentSources` param |
| `runtime/cli/native-routes-emit.ts` | pass `componentSources`; write `.components.json` + `.factory.ts` |
| `runtime/islands/native-render.ts` | add `resolveComponentContext`, `loadComponentManifest` |
| `runtime/routes.ts` | `Promise.all([resolveIslandContext, resolveComponentContext])` in native branch |
| `runtime/index.ts` (NAPI types) | update `compileJsx` signature |

## Testing

- Unit: `emit_factory` golden fixture (`Layout` with `Island` children).
- Unit: prop substitution — `<StaticNav title={greeting} native>` → correct Jinja.
- Unit: `{children}` slot substitution.
- Unit: auto-fallback — unannotated sub-component inside `native` → SSR slot emitted.
- Unit: circular inline → compile error.
- Integration: native route with SSR component (leaf + with-children).
- Integration: native route with `native` inline component.
- Integration: Island inside SSR component children — hydrates on client.
