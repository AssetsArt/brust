# SSR-component ISR — render-once SSR components with key/tags invalidation

**Status:** spec — reviewed (subagent, fix-then-plan applied 2026-05-31); ready to plan
**Date:** 2026-05-31
**Branch:** `feat/components`

## Goal

SSR components on native routes (`<Layout>`, `<Card>` … on a `native: true`
route) render via a generated JS-worker factory on **every request**:
`resolveComponentContext` (`runtime/islands/native-render.ts:254`) calls
`factories[i](data)` then `renderToString(node)` per request, invoked from
`runtime/routes.ts:626`. This is the same Bun-worker React-render path that the
island ISR work (`docs/superpowers/specs/2026-05-31-island-isr-cache-design.md`)
already proved is the arm/KVM jitter-bound bottleneck — the canonical
[[napi-crossing-floor]] cost.

This spec lets an SSR component opt into the **same ISR cache** the islands use:
`renderToString` of the component subtree runs **once per cache key**, the
rendered `comp_N_html` is frozen and stored Rust-side (shared across the worker
pool via the existing `MokaStore`), and subsequent same-key requests skip the
factory entirely and serve the cached HTML. The developer controls cache
identity with a loader-computed **key** + **tags**, and invalidates with the
existing `cache.invalidate({ key | tags })` API — **no new Rust or NAPI surface**.

Mental model: **Next.js ISR scoped to a server component**, riding entirely on
the island ISR infrastructure shipped in the sibling spec.

## Non-goals (this phase)

- **New cache backend / NAPI / Rust store changes.** `crates/brust/src/island_cache.rs`
  (`CacheStore`/`MokaStore`, tag reverse-index, TTL) and the three `island_cache_*`
  NAPI functions are reused **as-is**. The store is a generic string-keyed
  `{html, props}` cache; components store `props: ""`. No Rust diff in this phase.
- **Separate component keyspace.** The cache is **one cache**, shared with
  islands (user-approved). A single `cache.invalidate({ key })` evicts whichever
  of island/component holds that key; `{ tags }` evicts across both. The dev is
  responsible for keeping keys unique across islands + components.
- **Native-inline components (feature A, `<Comp native />`).** Compile-time Jinja
  expansion with no JS worker — a separate, larger, later spec
  (`docs/superpowers/specs/` TBD). ISR here targets the JS-worker SSR path only.
- **Caching the loader.** As with islands, the loader still runs every request
  (the key is loader-derived). Only the factory + `renderToString` is cached.
- **Per-component props attribute.** Islands cache `{html, props}` because the
  client hydrates the island from `data-brust-props`. SSR components emit no
  hydration props of their own (any nested `<Island>` bakes its OWN
  `data-brust-props` into the component HTML — see Invariant 2). So the cached
  `props` field is always `""`.

## Architecture

Three layers, each mirroring the already-shipped island ISR plumbing. The diff
is deliberately small: the compiler grows three IR/manifest fields and a shared
parser; the runtime grows a cache param on one function; Rust is untouched.

### 1. Compiler — capture `isr` from an SSR component

SSR-component authoring today (`crates/jsx-rust-compiler/src/lower.rs:403`
`lower_ssr_component`): named attrs + `{...spread}` lower to `Vec<SsrProp>`;
`key` is dropped, `ref`/event-handlers rejected, unknown attrs become props.

Add one recognized attribute, `isr`, consumed (NOT turned into a prop) only when
present:

```tsx
<Layout
  title={data.title}
  isr={{ key: data.cacheKey, tags: data.cacheTags, revalidate: 60 }}
>
  …
</Layout>
```

`isr` accepts the **identical** object shape the island form accepts
(`lower.rs:641` `"isr"` arm): `{ key: <path>, tags?: <path>, revalidate?: <number-literal> }`.
- `key` → `key_path` (dotted loader-data path, e.g. `"data.cacheKey"`), via the
  already-shared `expr_to_path` helper (`lower.rs:807`). **Required** when `isr`
  is present.
- `tags` → `tags_path` (dotted path resolving to `string[]`), same extractor. Optional.
- `revalidate` → `revalidate` (`u32` seconds; numeric **literal** only — same
  non-negative-integer, `≤ u32::MAX/1000` bound as islands, `lower.rs:678`). Optional.

**No `ssr` prerequisite** (unlike islands, where `isr` without `ssr` errors at
`lower.rs:724`). SSR components are always server-rendered, so `isr` alone is
meaningful — there is no client-only-component shape to guard against.

**Shared parser — extract `parse_isr_object`.** The island `isr` arm
(`lower.rs:641–696`) currently inlines the object walk: container → object →
per-prop `key`/`tags`/`revalidate` parse → mandatory-`key` check. Extract that
body into a reusable helper so the SSR-component arm does not duplicate it:

```rust
/// Parse an `isr={{ key, tags?, revalidate? }}` attribute object into
/// (key_path, tags_path, revalidate). `key` is MANDATORY and enforced here —
/// hence the first element is a plain `String`, not `Option` (a missing key is
/// an `err()` return, never a `None`). `revalidate` is a non-negative integer
/// literal ≤ u32::MAX/1000. `err` produces the caller's error variant (island
/// vs component) so a bad isr blames the right element.
fn parse_isr_object(
    jsx_attr: &swc_core::ecma::ast::JSXAttr,
    scope: &Scope,
    err: &dyn Fn() -> LowerError,
) -> Result<(String, Option<String>, Option<u32>), LowerError>
```

- `lower_island` calls `parse_isr_object` in its `isr` arm and wraps the key:
  `let (k, t, r) = parse_isr_object(jsx_attr, scope, &err)?; key_path = Some(k);
  tags_path = t; revalidate = r;` (behavior **identical** — pure refactor; the
  island's `ssr`-required check stays in `lower_island` after the attr loop,
  `lower.rs:724`, since it is island-specific). All existing island-ISR lower
  tests must still pass.
- `lower_ssr_component` adds an `"isr"` arm to its `match name.as_str()` block
  (`lower.rs:439`), alongside `"key" => continue` (`lower.rs:440`):
  ```rust
  "isr" => {
      let err = || LowerError::at(
          jsx_attr.span,
          ErrorKind::ComponentIsrUnsupported(component.clone()),
      );
      let (k, t, r) = parse_isr_object(jsx_attr, scope, &err)?;
      key_path = Some(k);
      tags_path = t;
      revalidate = r;
      continue;   // consumed — NOT pushed to props (must not leak as a factory prop)
  }
  ```
  with `let mut key_path/tags_path/revalidate` declared above the attr loop.

**IR — `crates/jsx-rust-compiler/src/ir.rs:76` `JsxNode::SsrComponent`** gains
three fields, mirroring `JsxNode::Island` (`ir.rs:105–111`):
```rust
key_path: Option<String>,
tags_path: Option<String>,
revalidate: Option<u32>,
```
The `lower_ssr_component` construction (`lower.rs:485`) sets them. ⚠️ Adding
fields breaks every **exhaustive** (non-`..`) destructure of the
`JsxNode::SsrComponent` variant. Audit of every `SsrComponent` match arm shows
all already use `..`, so none break — the plan must re-confirm each:
- `number_ssr_components` `lib.rs:194` — `{ instance, .. }` ✓
- `collect_islands` `lib.rs:183` — `SsrComponent { .. } => {}` ✓ (the *Island*
  arm at `lib.rs:148` is a fully-named exhaustive destructure, but it is a
  different variant — unaffected by this change)
- `collect_components` `lib.rs:220` — `{ component, instance, .. }` ✓ (adds the
  three fields to the `ComponentMeta` it pushes — see below)
- `number_islands` `lib.rs:133` — `{ children, .. }` ✓
- `emit_factory::collect_factories` `emit_factory.rs:19` — `{ component, props, children, .. }` ✓
- `emit_factory::emit_child` `emit_factory.rs:143` — `{ component, props, children, .. }` ✓
- `emit_jinja` `emit_jinja.rs:123` — `{ instance, .. }` ✓
- the `lower.rs` test-module destructure (`lower_ssr_component_leaf` ~`:2450`) — `{ component, props, .. }` ✓

**Manifest — `crates/jsx-rust-compiler/src/lib.rs:32` `ComponentMeta`** gains
`key_path`/`tags_path`/`revalidate` (parallel to `IslandMeta`, `lib.rs:59`).
`collect_components` (`lib.rs:226`) copies them from the IR node.
`components_to_json` (`lib.rs:293`, hand-rolled string-building — **no serde**)
emits `keyPath`/`tagsPath`/`revalidate` conditionally (omitted when `None`),
exactly as `islands_to_json` does (`lib.rs:270–283`). The change is additive
appends inside the existing per-entry loop; the empty-input `"[]"` early return
(`lib.rs:294`) is untouched.

**Error — `crates/jsx-rust-compiler/src/lib.rs:355` `ErrorKind`** gains
`ComponentIsrUnsupported(String)` carrying the component name (NOT mentioning
"island"; pattern matches the existing `SsrComponentInMapNotSupported(String)`,
`lib.rs:427`):
```rust
#[error("`isr` on `<{0}/>` must be `{{ key: <path>, tags?: <path>, revalidate?: <number-literal> }}`")]
ComponentIsrUnsupported(String),
```

**Emitters — NO change.** `emit_factory.rs` (`{ component, props, children, .. }`,
`:19`/`:143`) and `emit_jinja.rs` (`{ instance, .. }`, `:123`) already cover the
new fields via `..`. `isr` is never a factory prop (consumed in lower), so it
cannot leak into the emitted `h(Component, {…})`.

### 2. Runtime — cache get/set around the factory render

In `resolveComponentContext` (`native-render.ts:254`), add an optional `cache`
param and an ISR fast-path that **mirrors the ISR *logic* of
`resolveIslandContext` (`native-render.ts:124`)** — same key-resolve / hit /
write-through shape. (Signatures differ: `resolveComponentContext` keeps its
`templateName`/`jinjaDir` params because it loads the factory file, and on a hit
it sets only `comp_N_html` — there is no `comp_N_props` slot, see Invariant 5.)

```ts
export interface NativeComponentEntry {
  component: string
  instance: number
  sourcePath: string
  keyPath?: string      // dotted path into loader data → ISR cache key (string)
  tagsPath?: string     // dotted path → ISR cache tags (string[])
  revalidate?: number   // SECONDS; → ttlMs on cache.set
}

export async function resolveComponentContext(
  manifest: NativeComponentEntry[],
  data: unknown,
  templateName: string,
  jinjaDir?: string,
  cache?: IslandCache,
): Promise<Record<string, string>> {
  …
  for (let i = 0; i < manifest.length; i++) {
    const entry = manifest[i]!

    // ISR fast-path: resolve a string key out of loader data. HIT serves frozen
    // html and skips the factory. Non-string-but-defined key → warn + uncached.
    let key: string | undefined
    if (cache && entry.keyPath) {
      const k = pathInto(data, entry.keyPath)
      if (typeof k === 'string') {
        key = k
        const hit = cache.get(key)
        if (hit) {
          out[`comp_${entry.instance}_html`] = hit.html
          continue
        }
      } else if (k !== undefined) {
        console.warn(`[brust] SSR component "${entry.component}" ISR keyPath "${entry.keyPath}" resolved to a non-string value; rendering uncached`)
      }
    }

    try {
      if (!factoryMod?.factories?.[i]) throw new Error(`factory[${i}] not found in ${factoryPath}`)
      const node = factoryMod.factories[i]!(data)
      const html = renderToString(node as React.ReactNode)
      out[`comp_${entry.instance}_html`] = html
      // Write-through: SUCCESS path only (a throwing render must not poison the
      // cache). props is "" — components have no separate hydration props attr.
      if (cache && key) {
        let tags: string[] = []
        if (entry.tagsPath !== undefined) {
          const tagsValue = pathInto(data, entry.tagsPath)
          if (Array.isArray(tagsValue) && tagsValue.every((t) => typeof t === 'string')) {
            tags = tagsValue
          } else if (tagsValue !== undefined) {
            console.warn(`[brust] SSR component "${entry.component}" ISR tagsPath "${entry.tagsPath}" must resolve to a string[]; using no tags`)
          }
        }
        const ttlMs = entry.revalidate !== undefined ? entry.revalidate * 1000 : undefined
        cache.set(key, tags, ttlMs, html, '')
      }
    } catch (e) {
      console.error(`[brust] SSR component "${entry.component}" renderToString failed; degrading to empty:`, e)
      out[`comp_${entry.instance}_html`] = ''   // existing degrade behaviour, unchanged
    }
  }
  return out
}
```

A component **without** `keyPath` keeps today's exact behavior (factory render
every request). The `factoryCache`/`componentManifestCache` and the
degrade-to-empty catch (`native-render.ts:286`) are untouched.

**Wiring — `runtime/routes.ts:626`.** Pass the existing `islandCache` singleton
(`routes.ts:30`) into the call:
```ts
? resolveComponentContext(compManifest, rt, flat.nativeTemplate, undefined, islandCache)
```
(`jinjaDir` stays `undefined` to keep the prod default; `islandCache` is the same
port already passed to `resolveIslandContext` at `routes.ts:623`.)

**Rust — NO change.** `island_cache.rs` is a generic string-keyed
`{html, props}` store; `cache.set(key, tags, ttlMs, html, '')` stores `props=""`.
Shared keyspace = the same `MokaStore` singleton.

### 2b. TypeScript surface — `isr` is auto-typed (post-ship addendum)

`isr` is a compiler pseudo-prop (stripped at lower time, never reaches the
component at runtime — the factory carries no `isr`), exactly like React's
`key`/`ref`. A user SSR component's own props type does NOT declare `isr`, so
without help `<MyLayout isr={{…}}>` is a TS error. Fix (shipped): a global JSX
augmentation in `runtime/islands/isr-jsx.ts` adds `isr?: IsrConfig` to
`React.JSX.IntrinsicAttributes` (the interface `react-jsx` consults for every
element — where `key` lives), so `isr` is accept-anywhere with zero
per-component boilerplate. `IsrConfig` is exported from `brustjs`; `IslandProps.isr`
reuses it. `runtime/index.ts` side-effect-imports the augmentation so it loads in
any consumer's program.

- **Augment `React.JSX.IntrinsicAttributes`, NOT `React.Attributes`** — under
  React 19's `export = React` types, augmenting `React.Attributes` does not
  propagate through the module boundary; targeting `React.JSX.IntrinsicAttributes`
  directly is the form that merges.
- A stale nested `runtime/node_modules/@types/react@18` (absent from `bun.lock`,
  orphaned) shadowed root `@19` and made the augmentation land on the wrong
  version in-repo; removed during verification. See [[published-install-tarball-test]].

### 3. Reused infrastructure (no diff)

- `crates/brust/src/island_cache.rs` — `CacheStore`/`MokaStore`, tag reverse
  index, lazy TTL expiry, `clear()` (dev hot-reload).
- NAPI `island_cache_get`/`island_cache_set`/`island_cache_invalidate`/`island_cache_clear`.
- `IslandCache` port (`native-render.ts:43`) — reused under its current name; it
  is effectively a generic HTML-fragment cache. **Do not rename** (minimal diff;
  a rename churns the island call sites for no behavioral gain).
- `cache.invalidate({ key | tags })` TS API and the dev-reload `island_cache_clear`
  call already cover component entries (shared keyspace).

## Data flow (per request, native jinja route)

```
Rust → worker (routes.ts native branch)
  loader(ctx) ───────────────────────────────► data           (TS, always runs)
  resolveComponentContext(manifest, data, tmpl, undefined, islandCache):
    for each component with isr:
      key = pathInto(data, keyPath)
      cache.get(key) ──NAPI──► Rust MokaStore (shared with islands)
        hit  → comp_N_html = frozen html        (NO factory, NO renderToString)  ✅
        miss → node = factories[i](data); html = renderToString(node)
               cache.set(key, tags, ttlMs, html, "") ──NAPI──► Rust
  merge comp_N_html into context → SAB → napiRenderJinja → response

elsewhere (action / api route):
  cache.invalidate({ tags }) ──NAPI──► Rust evict ──► next request misses → re-render
```

## Invariants (load-bearing)

1. **Opt-in, zero-overhead default.** No `isr` → byte-identical to today's
   factory-every-request path. The cache code is reached only when `cache` is
   passed AND `entry.keyPath` is present.

2. **Nested islands are baked into the cached HTML.** An `<Island>` inside an
   `isr` component renders through the factory's `h(Island, …)` path, so its
   `data-brust-props` attribute is part of the `comp_N_html` string that gets
   frozen. A later hit serves that exact HTML; the client hydrates from the
   frozen attr → no mismatch. (`collect_islands` already excludes
   `SsrComponent.children` from `.islands.json`, `lib.rs:183`, so the nested
   island is never resolved separately — it only exists inside the component HTML.)

3. **`isr` on a nested `<Island>` is inert (silently).** The enclosing
   component's ISR governs caching. `emit_factory::emit_child`'s Island arm
   (`emit_factory.rs:125`) destructures `{ component, props_path, hydrate, ssr, .. }`
   — it never reads `key_path`/`tags_path`/`revalidate`, so the emitted
   `h(Island, …)` carries no isr. Confirmed inert by construction; no compiler
   change needed for this case.

4. **Miss-only render; throw does not poison.** `factories[i](data)` +
   `renderToString` run on a miss only. A throwing render degrades to
   `comp_N_html = ""` (existing behavior, `native-render.ts:291`) and does NOT
   call `cache.set`.

5. **`props=""` is intentional.** Components carry no separate hydration props
   attribute (Non-goals). Storing `""` keeps the shared `{html, props}` store
   value-correct; the component path never reads `hit.props`.

6. **Cold-miss stampede is wasteful-but-correct.** Two workers hitting the same
   cold key both render + both `cache.set`; renders are deterministic from the
   same loader `data`, so last-write-wins is safe (inherits island Invariant 6).

7. **Shared keyspace, shared invalidation.** One key collision between an island
   and a component means `invalidate({ key })` evicts whichever currently holds
   it; `invalidate({ tags })` spans both. This is the user-approved "one cache"
   model — documented, not a bug.

## Testing

- **Compiler (Rust unit, `lower.rs`/`lib.rs`):**
  - `lower_ssr_component` parses `isr` → IR node has `key_path`/`tags_path`/`revalidate`.
  - `isr` does NOT appear as a prop in the emitted `factory_expr` (consumed in lower).
  - `isr` without `key` → `ComponentIsrUnsupported`.
  - non-literal/fractional/negative/oversized `revalidate` → `ComponentIsrUnsupported`.
  - `components_to_json` golden with `isr` (conditional `keyPath`/`tagsPath`/`revalidate` keys) and without.
  - **All existing island-ISR lower tests still pass** (shared `parse_isr_object`
    refactor — no regression; this is the load-bearing refactor guard).
- **Runtime (bun, `runtime/islands/native-render.test.ts`):** fake-`IslandCache` spy.
  - cache HIT → `factories[i]` NOT called, `comp_N_html = hit.html`.
  - MISS → render, then `cache.set(key, tags, ttlMs, html, "")` called once.
  - non-string key → no `cache.set`, uncached render, warn.
  - bad `tagsPath` → `cache.set` called with `tags = []`, warn.
  - factory throw after miss → `comp_N_html = ""`, NO `cache.set`.
- **Integration (`tests/native-island-ssr.test.ts` — has the `brust build` +
  cwd=FIXTURE_DIR harness; run this file SEPARATELY per
  [[native-island-integration-flake]] / [[bun-mock-module-leaks-suite]]):**
  - native route with `<Layout isr={{ key }}>` requested twice → component
    factory renders **once** (prove via an in-component render counter / marker).
  - `cache.invalidate({ key })` between requests → re-render.

## Acceptance criteria

- An `isr`-annotated SSR component renders once per key and serves cached
  `comp_N_html` on later same-key requests.
- `cache.invalidate({ key | tags })` evicts the component entry (shared keyspace).
- Island ISR is **not regressed** (shared `parse_isr_object`).
- No Rust/NAPI diff; `island_cache.rs` untouched.
- Full baselines green: `cargo test --workspace`, `bun test runtime/`,
  `bun run ci` (biome), `tests/native-island-ssr.test.ts`, `tests/integration.test.ts`.

## Known limitations

- Loader still runs on a hit (key is loader-derived) — same as islands.
- In-memory cache; empties on full process restart (not worker restart). Redis
  adapter is the future persistence answer (island spec, deferred).
- Pure TTL on `revalidate` expiry (cold miss next request); no
  stale-while-revalidate.
- **`isr` on a nested `<Island>` is silently inert this phase** (Invariant 3) —
  no compile diagnostic. The brust compiler emits errors only (no warning
  channel), so adding a "nested-island isr ignored" warning is out of scope; a
  diagnostic is deferred to whenever the compiler grows a warning surface. The
  enclosing component's `isr` is the documented way to cache that subtree.
- **`factoryCache` (`native-render.ts:248`) is not invalidated on a rebuild**
  (pre-existing, shared with `componentManifestCache`). ISR *amplifies* the blast
  radius: a stale factory's output gets frozen into the cache. In `brust dev`
  this is moot — the worker restart drops `factoryCache` and the dev-reload path
  calls `island_cache_clear` (island spec Invariant 7). In production a rebuild
  implies a process restart, which empties both. So the window is closed in
  practice; noted for completeness.

## Open questions — resolved at plan time

1. **Where does `parse_isr_object` live?** → `lower.rs`, free function next to
   `expr_to_path` (`lower.rs:807`); both `lower_island` and `lower_ssr_component`
   call it. The refactor of `lower_island`'s arm is part of the first compiler task.
2. **`cache` param position on `resolveComponentContext`** → appended after the
   existing `jinjaDir?` (5th param), so the prod call passes
   `(manifest, rt, tmpl, undefined, islandCache)`. Keeps `jinjaDir` test-injection working.
3. **Does the component path ever read `hit.props`?** → No. `props=""` stored;
   only `hit.html` consumed. (Invariant 5.)
