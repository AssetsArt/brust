# Native page components — non-Island SSR components on native routes

**Status:** spec — reviewed (subagent 2026-05-31, blockers fixed); ready to plan
**Date:** 2026-05-31

## Goal

Native (`native: true`) routes compile TSX → Jinja and render Rust-side, bypassing
React on the hot path. Currently the compiler (`jsx-rust-compiler`) rejects every
capitalized component that is not `<Island>` or `<BrustPage>` with
`CustomComponentNotSupported`. This prevents code reuse: a `<Layout>` wrapper, a
`<Card>`, a `<StaticNav>` — all unavailable on native routes today.

This spec adds **SSR components** — non-Island capitalized components on native pages
that are rendered server-side by the JS worker via `renderToString` and emit no client
JS. The client receives static HTML; Islands *inside* those components still hydrate
normally.

```tsx
// native page — works after this spec
<Layout title={greeting}>
  <h1>{greeting}</h1>
  <Island component={Counter} props={data.counter} hydrate="load" />
</Layout>
```

## Non-goals (this spec)

- **`native` inline path** — compile-time Jinja expansion of a component's source.
  Deferred to a follow-on spec. The `native` attribute on non-Island components is
  **not recognised** by this implementation; it is reserved for the follow-on spec.
- ISR caching of SSR component output.
- `native` inline propagation / prop substitution / `ChildrenSlot` IR node.
- Hot-reload of SSR components on `.tsx` edit (same deferred status as native page hot-reload).
- `native: true` components that import other packages (own-project relative imports only).
- Route-level page cache.

## Behaviour rules

### SSR component (default)

Any capitalized tag in a native page that is not `<Island>` or `<BrustPage>` is an
**SSR component**. The compiler emits a `{{ comp_N_html | safe }}` slot in the Jinja
template. At request time the JS worker renders the component (and its entire React
subtree, including any `<Island>` children) via a generated factory function, and
fills the slot.

```tsx
// Page.tsx (native: true)
<Layout title={greeting}>
  <h1>{greeting}</h1>
  <Island component={Counter} props={data.counter} hydrate="load" />
  <Island component={Counter} props={data.counter} hydrate="load" ssr />
</Layout>
```

- `<Layout>` renders server-side; client gets static HTML for its shell.
- `<Island>` tags inside SSR component children: Island.tsx React-path render creates
  `data-brust-*` markers + SSR HTML inside the factory's `renderToString`. Client
  bootstrap hydrates them via `data-brust-props` DOM attributes — not via Jinja
  template variables. Islands inside SSR components do NOT appear in `.islands.json`
  and do NOT get `island_N_props`/`island_N_html` context keys; client hydration reads
  props directly from the `data-brust-props` attribute Island.tsx writes.
- `<Island isr>` inside SSR component children: ISR Rust-side cache does **not**
  apply (island embedded in `comp_N_html`, not rendered separately).
- Sub-components inside `<Layout>` (in the component file): React's `renderToString`
  handles the whole tree; no annotation needed.

### Instance numbering

SSR components use an independent counter (`comp_0`, `comp_1`, …) separate from the
island counter (`island_0`, `island_1`, …). Both are source-order monotonic.

### Island chunk discovery for Islands inside SSR components

`scanIslandChunks` (runtime build step) currently scans only page `.tsx` source files.
Islands referenced inside SSR component source files (e.g., `Counter` inside
`Layout.tsx`) will not be discovered and their JS chunks won't be built. Fix:
`emitNativeTemplates` scans each SSR component's resolved source file for
`<Island component={X} />` patterns and records those component identifiers so the
island chunk build step includes them. Concretely: after resolving `componentsJson`
source paths, call `scanIslands(componentSourcePath)` for each entry and merge the
results into the page's island set.

### Props lowering for SSR components

SSR component attributes use a **dedicated attr-lowering loop** (modelled on
`lower_island`'s loop), not `lower_attr`. This is required because `lower_attr`
rejects arbitrary camelCase prop names via `UnknownAttributeRename`. The dedicated
loop accepts any attribute name that is not `key`, `ref`, or an event handler
(`on[A-Z]…` — rejected as `EventHandlerNotSupported`). Attribute values follow the
same Expr-lowering rules as `lower_attr` (`Expr` variants for dynamic, `StaticText`
for string literals, etc.).

### Contained failure

If the factory's `renderToString` throws: degrade to `comp_N_html = ""` (empty string,
not an error response) + `console.error`. The Jinja slot renders an empty section —
visible only as blank space, no page crash. Mirrors the SSR island failure behaviour.

### No-manifest fast path

`routes.ts` preserves the existing no-manifest fast path: when BOTH island manifest and
component manifest are absent or empty, the loader data is shipped directly without
context augmentation. SAB-size 413 guard is re-checked after merging both island and
component extras (the merged context can be larger than either alone).

## Architecture

### Build time

#### 1. Rust compiler — new IR node + emitters

**`ir.rs`** — add:
```rust
JsxNode::SsrComponent {
    component: String,       // identifier from tag name
    instance: usize,         // source-order index (set by number_islands companion)
    props: Vec<JsxAttr>,     // lowered via dedicated attr loop
    children: Vec<JsxNode>,  // lowered children (may contain Islands)
}
```

All existing walkers (`number_islands`, `collect_islands`, `infer_props_types`,
`collect_map_member_fields`) must add an explicit arm for `SsrComponent`:
- `number_islands`: recurse into `children` (Islands inside must be numbered) — **but
  do not number the `SsrComponent` itself as an island**.
- `collect_islands`: recurse into `children` — Islands inside SSR components are
  collected into the page island manifest normally (they still need `island_N_props` if
  they are client-only; for SSR Islands inside SSR components the manifest entry exists
  but `island_N_html` is NOT filled — the factory handles SSR rendering).

  **Wait — revised rule (see Open Question 1 resolution below):** Islands inside SSR
  component children are rendered by the factory's `renderToString`. They do NOT need
  `island_N_html` from the worker's separate island pass. However they DO need
  `island_N_props` in the template context so the client bootstrap can read the props
  for hydration IF the Island is client-only. But if the Island is inside
  `comp_N_html`, the Jinja template has no `{{ island_N_props }}` slot for it — the
  `data-brust-props` attribute is written directly by Island.tsx during `renderToString`.
  **Resolution**: Islands inside SSR components are NOT added to `.islands.json` at all.
  Island.tsx React-path render writes `data-brust-props` from the `props` object passed
  to the factory. No separate `island_N_props` key needed. `collect_islands` must
  **skip** children inside `SsrComponent` nodes.

- `infer_props_types`: treat `SsrComponent` as opaque — do not recurse into its props
  or children (avoids incomplete prop struct when all data flows through an SSR
  component).
- `emit_jinja`: emit `{{ comp_N_html | safe }}` for `SsrComponent`.

**`emit_factory.rs`** (new file) — walks the IR and for each `SsrComponent` emits a
`(ctx) => h(Component, { …props }, …children)` TypeScript expression. Expression
mapping:
- `Expr::Field("x")` → `ctx.x`
- `Expr::MemberAccess { root:"a", path:["b","c"] }` → `ctx.a.b.c`
- `Expr::StaticText("s")` → `"s"` (quoted)
- `Expr::StaticNum(n)` → `n`
- `JsxNode::Element { tag, attrs, children }` → `h("tag", { …attrs }, …children)`
- `JsxNode::Island { component, props_path, hydrate, ssr, … }` →
  `h(Island, { component: ComponentName, props: ctx.propsPath, hydrate: "…", ssr: bool })`
- `JsxNode::Text(s)` → `"s"` (quoted, or null if empty)
- `JsxNode::Expr(e)` → `ctx.path`
- `JsxNode::Map { source, binding, body }` → `ctx.source.map((binding) => body)`

All components (leaf AND with-children) use the factory code path. There is no
separate "leaf component" path — a factory with no children is just
`(ctx) => h(Layout, { title: ctx.greeting })`.

#### 2. `compile_full` / NAPI interface

The `Compiled` struct in `lib.rs` gains:
```rust
pub struct Compiled {
    pub template: String,
    pub islands: Vec<IslandMeta>,
    pub components: Vec<ComponentMeta>,  // new
}
```

`ComponentMeta`:
```rust
pub struct ComponentMeta {
    pub component: String,   // identifier
    pub instance: usize,
    pub factory_expr: String, // the (ctx) => h(…) TS expression string
}
```

**`compile_full` signature is unchanged** — the golden harness (`compile_with_path`)
depends on it. The NAPI wrapper (`jsx_compile.rs`) calls a new helper
`components_to_json(&compiled.components)` analogous to `islands_to_json`.

`componentSources` for `native` inline is **not added to `compile_full`** — deferred
with the `native` inline spec.

#### 3. TS build step — `emitNativeTemplates` additions

**`native-routes-emit.ts`**:

After `compileJsx` returns `componentsJson`:
1. Parse `componentsJson` → array of `{ component, instance, factoryExpr }`.
2. Resolve `sourcePath` for each component from `pageImports` (same as island
   reconcile). Write `<Name>.components.json` (enriched with `sourcePath`).
3. Write `<Name>.factory.ts` to `.brust/jinja/`:

```typescript
// NativeIslands.factory.ts  (auto-generated, do not edit)
import Layout from '/abs/path/components/Layout.tsx'
import Counter from '/abs/path/components/Counter.tsx'
import { Island } from 'brustjs'
import { createElement as h } from 'react'

export const factories: Array<(ctx: any) => React.ReactNode> = [
  // comp_0: <Layout title={greeting}>…</Layout>
  (ctx) => h(Layout, { title: ctx.greeting },
    h('h1', null, ctx.greeting),
    h(Island, { component: Counter, props: ctx.data.counter, hydrate: 'load' }),
  ),
]
```

4. **Island chunk discovery fix**: after resolving component `sourcePath`s, call
   `scanIslands(sourcePath)` for each SSR component source and merge discovered Island
   component identifiers into the page's island set (so the build step builds their
   JS chunks).

### Request time

#### 4. `native-render.ts` — `resolveComponentContext` (new)

```typescript
export interface NativeComponentEntry {
  component: string
  instance: number
  sourcePath: string
}

export async function resolveComponentContext(
  manifest: NativeComponentEntry[],
  data: unknown,
  templateName: string,
  jinjaDir?: string,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  if (!manifest.length) return out
  const dir = jinjaDir ?? path.resolve(process.cwd(), '.brust/jinja')
  const factoryPath = path.resolve(dir, `${templateName}.factory.ts`)
  const { factories } = await import(factoryPath)
  for (let i = 0; i < manifest.length; i++) {
    try {
      const node = factories[i](data)
      out[`comp_${i}_html`] = renderToString(node)
    } catch (e) {
      console.error(`[brust] SSR component "${manifest[i].component}" renderToString failed:`, e)
      out[`comp_${i}_html`] = ''
    }
  }
  return out
}
```

Factory import is cached by Bun's module system (same as component imports in
`resolveIslandContext`). The factory file path is derived from `templateName` to avoid
an extra manifest field.

#### 5. `routes.ts` — native branch

```typescript
const compManifest = loadComponentManifest(flat.nativeTemplate)
const [islandExtra, componentExtra] = await Promise.all([
  manifest?.length ? resolveIslandContext(manifest, rt, islandCache) : Promise.resolve({}),
  compManifest?.length
    ? resolveComponentContext(compManifest, rt, flat.nativeTemplate)
    : Promise.resolve({}),
])
const ctx = { ...rt, ...islandExtra, ...componentExtra }
// SAB-size 413 guard applied to ctx (same as current island-only guard)
```

#### 6. Rust server — unchanged

`jinja.rs` renders `{{ comp_N_html | safe }}` identically to `{{ island_N_html | safe }}`.

## Open questions resolved

**Q1 — Islands inside SSR components and island manifest:** Islands inside SSR
component children are **not added to `.islands.json`**. `collect_islands` skips
`SsrComponent.children`. Island.tsx React-path render writes `data-brust-props`
directly into the DOM attribute during the factory's `renderToString`; no separate
`island_N_props` Jinja variable is needed. Client bootstrap reads `data-brust-props`
from the DOM — this is the existing mechanism on the React-path (non-native) too.

**Q2 — `infer_props_types` for `SsrComponent`:** Treat as opaque — do not recurse.
Pages that route all data through an SSR component will have an incomplete prop struct,
but that struct is only used for Rust-side typed access; the Jinja template renders
opaquely via `{{ comp_N_html | safe }}`. No practical impact.

**Q3 — Contained failure / no-manifest fast path:** Empty slot renders blank space,
no crash. No-manifest fast path preserved: skip both `resolveIslandContext` and
`resolveComponentContext` when both manifests are absent/empty.

**Q4 — `native` inline scope:** Deferred to follow-on spec. Not in this plan.

## File changes summary

| File | Change |
|---|---|
| `crates/jsx-rust-compiler/src/ir.rs` | add `JsxNode::SsrComponent` |
| `crates/jsx-rust-compiler/src/lower.rs` | recognise non-Island/BrustPage capitalised tags → `SsrComponent`; dedicated camelCase-safe attr loop; walker arms for `SsrComponent` |
| `crates/jsx-rust-compiler/src/emit_jinja.rs` | emit `{{ comp_N_html \| safe }}`; walker arm for `SsrComponent` |
| `crates/jsx-rust-compiler/src/emit_factory.rs` | **new** — IR → `(ctx) => h(…)` factory TS expression |
| `crates/jsx-rust-compiler/src/lib.rs` | `Compiled` gains `components: Vec<ComponentMeta>`; `ComponentMeta` struct; `components_to_json`; NAPI wrapper updated |
| `runtime/cli/native-routes-emit.ts` | write `.components.json` + `.factory.ts`; scan SSR component sources for Island identifiers |
| `runtime/islands/native-render.ts` | add `resolveComponentContext`, `loadComponentManifest` |
| `runtime/routes.ts` | `Promise.all` for island + component context; 413 guard on merged ctx |

## Testing

- Unit (Rust): `emit_factory` golden — `<Layout title={greeting}>` with Island child →
  correct `(ctx) => h(Layout, …)` expression.
- Unit (Rust): `lower_element` recognises SSR component, stores attrs, children.
- Unit (Rust): `collect_islands` skips `SsrComponent.children`.
- Unit (Rust): `compile_full` returns non-empty `components` for a page with an SSR
  component.
- Unit (TS): `resolveComponentContext` calls factory + `renderToString` → returns
  `comp_0_html`.
- Unit (TS): contained failure — factory throws → `comp_0_html = ""`, no throw.
- Integration: native route with leaf SSR component (`<Header />`).
- Integration: native route with SSR component wrapping children + Island inside →
  Island hydrates on client.

## Acceptance criteria

1. `<Layout>` on a `native: true` route compiles without error and renders its HTML
   server-side (no client JS for Layout itself).
2. `<Island>` inside `<Layout>` children hydrates on the client exactly as it does on
   a React-path route.
3. `cargo test --workspace` and `bun test runtime/` green.
4. Integration test for native-with-SSR-component passes.
5. Existing native route tests (`NativeProfile`, `NativeIslands`) unaffected.

## Known limitations

- `native` attribute is reserved but not yet implemented (follow-on spec).
- Islands inside SSR components do not benefit from ISR caching.
- SSR component `renderToString` runs per-request (no caching in this phase).
- `scanIslands` for component source files is one-level only (not recursive).
