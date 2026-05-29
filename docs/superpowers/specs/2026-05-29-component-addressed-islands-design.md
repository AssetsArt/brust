# Component-addressed islands — design

**Date:** 2026-05-29
**Status:** spec (autonomous pipeline, `/ny-auto-pipeline component-addressed islands`)
**Supersedes parts of:** `2026-05-29-native-islands-design.md` (the `id`/`island.config.ts` mechanism)

## Goal

Let a user place `<Island component={X} props={…}/>` **any number of times, with the
same or different components, on the same page or across pages, writing nothing
extra** — no `id=` attribute, no `island.config.ts`. Delete `island.config.ts`
from the framework entirely. The island's chunk and its server-side source are
both derived automatically from the `component={X}` reference that is already in
the source.

### Concretely, this must compile and work with zero other files touched:

```tsx
import Counter from '../components/Counter'

export default function Page({ a, b }) {
  return (
    <div>
      <Island component={Counter} props={a} />        {/* client-only */}
      <Island component={Counter} props={b} ssr />     {/* same component, ssr, distinct instance */}
    </div>
  )
}
```

Today this is a **compile error** (`DuplicateIslandId("Counter")`) and additionally
requires `Counter` (and any aliases) to be registered in `island.config.ts`.

## Background — why `island.config.ts` exists today

`island.config.ts` is a hand-maintained `Record<islandId, sourcePath>`. It has
exactly two consumers (the client `bootstrap.ts` does **not** use it — it resolves
`/_brust/islands/<id>.js` dynamically from the DOM `data-brust-island` attribute):

1. **`buildIslands`** (`runtime/islands/build.ts`) — iterates `cfg.islands` to emit
   one bundled chunk `<id>.js` per island. Both React-path and native-path islands
   rely on these chunks existing at runtime.
2. **Native reconcile** (`runtime/cli/native-routes-emit.ts` →
   `loadIslandConfigMap` + `reconcileIslandManifest`) — resolves each island's
   `sourcePath` for server-side `renderToString` (ssr islands) and validates that
   every compiler-emitted island id ∈ config.

The single `id` value is overloaded for **three** distinct jobs:

- **chunk identity** — the `.js` bundle URL `/_brust/islands/<id>.js` (per *component*)
- **instance identity** — the jinja context slots `island_<id>_props` / `island_<id>_html` (per *occurrence*)
- the `data-brust-island` DOM marker value

Because instance identity is keyed on `id`, two `<Island>` using the same component
collide on the context keys → the compiler rejects duplicate ids → the user must
invent distinct ids (`ClientCounter`, `ServerCounter`) → those distinct ids must be
registered in `island.config.ts`. The config exists to paper over the overload.

## High-level architecture — split the two identities

| Identity | Keyed on (new) | Derived from | Used by |
|---|---|---|---|
| **chunk** | `component` (the source identifier, e.g. `Counter`) | the `component={Ident}` ref already in source | chunk filename `<component>.js`, `data-brust-island` attr, client `import()` |
| **instance** | `instance` (source-order index `0,1,2…`) | compiler numbering pass | jinja context keys `island_<instance>_props` / `_html` (server-side only) |

The client never sees `instance` — it reads the already-substituted JSON from the
per-marker `data-brust-props` attribute and the chunk URL from `data-brust-island`.
`instance` lives only in (a) the emitted jinja context-key names and (b) the
runtime that fills those keys.

The source identifier is the chunk key because **the compiler reads source, not
runtime artifacts** — the ident `Counter` is always available at compile time,
unaffected by browser minification (minify mangles chunk internals, never the
chunk filename or the marker). This removes the only reason `id=` existed
(stable naming under minification), so `id=` is **dropped entirely**.

### Where chunk source paths come from (no config)

- **Native path:** the compiler emits the `component` ident into the manifest. The
  reconcile step resolves that ident → absolute source via the **page's own
  imports** (the page file is already known: `importMap.get(routeName)`), the same
  regex `scanImports` already used for routes. No config, no id-validation.
- **React path:** `buildIslands` has no compiler pass, so a new build-time scanner
  walks every page module imported by `routes.tsx`, finds `<Island component={Ident}>`
  occurrences (regex), resolves each `Ident` → source via that page's imports, and
  produces a `Map<componentName, absoluteSourcePath>`. `buildIslands` builds one
  chunk per unique entry. This same scan covers native pages too (they are also
  imported by `routes.tsx`), so a single scanner feeds all chunk building.

### Chunk-key collision rule

Two **different** source files whose island component shares a name (`Counter`)
would both map to `Counter.js`. The scanner detects `name → two distinct paths`
and **throws a build error** naming both files. This is the one new constraint:
**island component names must be unique across the app.** Rare, with a clear fix
(rename or alias one). Documented in Limitations.

## Compiler changes (`crates/jsx-rust-compiler`)

### `ir.rs` — `JsxNode::Island`

```rust
Island {
    /// Source identifier from `component={Ident}` — the chunk key.
    component: String,
    /// Source-order index within this template, assigned by the numbering pass.
    instance: usize,
    /// Single-segment path into the route prop context (unchanged).
    props_path: String,
    /// load/idle/visible/interaction (unchanged).
    hydrate: String,
    /// Server-render the initial markup (unchanged).
    ssr: bool,
}
```

`id` field is removed. `instance` defaults to `0` from lowering and is overwritten
by the numbering pass (below) before emit/collect.

### `lower.rs` — `lower_island`

- Keep `island_component_ident` (returns the ident sym) → store as `component`.
- **Validate the component ident charset at lower time.** `island_component_ident`
  accepts any `Ident` sym, but a JS-legal ident can contain `$` (`Foo$Bar`), which
  fails both `isValidIslandId` (`build.ts:101`, `[A-Za-z0-9_-]`) and
  `is_safe_island_filename` (`src/server.rs`, `[A-Za-z0-9_.-]`). Since the component
  ident is now the chunk filename + `data-brust-island` value, reject any component
  ident not matching `[A-Za-z0-9_]+` at lower time with a clear compile error (a new
  `IslandBadComponentName` variant) rather than letting it surface as a build/serve
  failure. (PascalCase idents — the norm — pass; this only rejects `$`/exotic names.)
- **Remove `explicit_id`/`default_id`/`id` logic.** `lower.rs:434` derives
  `id = explicit_id.unwrap_or(component_id)`; that whole derivation goes — the node
  carries `component` directly. **CRITICAL (do not merely delete the `"id"` match
  arm):** the attribute `match` ends with `_ => {}` (`lower.rs:426`, "unknown
  attributes ignored, forward-compatible"). Deleting the `id` handling alone makes a
  now-illegal `id=` fall through to `_ => {}` and be **silently dropped** — the exact
  mode the spec forbids. The plan MUST **add an explicit `"id" => return Err(…)`
  arm** (a new `IslandIdAttrRemoved` error with a migration message:
  "`id=` is no longer supported; islands are addressed by `component={…}` — remove
  the `id` attribute"). The `_ => {}` arm stays for genuinely-unknown attrs.
- `props_path`, `hydrate`, `ssr`, the `.map`/children/self-closing guards: unchanged.

### `lib.rs` — numbering pass, collect, manifest

- New `number_islands(node: &mut JsxNode, counter: &mut usize)`: pre-order DFS,
  assigns `instance = *counter; *counter += 1` to each `Island`. Called in
  `compile_full` after `lower`, before `emit` and `collect_islands`. Both emit and
  collect then read the **same** `node.instance` — no fragile "two walks agree by
  position" coupling.
- `collect_islands`: push `component` + `instance` (+ existing fields).
- **`IslandMeta`** new shape: `{ component: String, instance: usize, props_path: String, ssr: bool, hydrate: String }`.
- **`islands_to_json`** new JSON (camelCase): `{"component":"Counter","instance":0,"propsPath":"data.a","ssr":true,"hydrate":"load"}`.
- **Remove** the `DuplicateIslandId` rejection loop (reuse is now the goal;
  instances are unique by construction). Remove the `DuplicateIslandId` error
  variant. Keep `seen`-based dedup? **No** — delete it.
- **`ErrorKind` net change:** remove `DuplicateIslandId` + `IslandBadId`; add
  `IslandIdAttrRemoved` (illegal `id=` attr, see lower.rs) and
  `IslandBadComponentName` (component ident outside `[A-Za-z0-9_]+`).

### `emit_jinja.rs` — island branch

```
<div data-brust-island="{component}" data-brust-props="{{ island_{instance}_props }}" data-brust-hydrate="{hydrate}"[ data-brust-csr | >{{ island_{instance}_html | safe }}</div>]
```

- `data-brust-island` = `component` (chunk key).
- context keys use `instance`: `island_{instance}_props`, `island_{instance}_html`.
- `component` is a source ident (`[A-Za-z0-9_]+`), safe verbatim; `instance` is a
  number, safe verbatim. No escaping (byte-equal goldens depend on no escaping).

## Runtime changes (`runtime/`)

### `islands/native-render.ts`

- `NativeIslandEntry`: `{ component: string, instance: number, propsPath: string, ssr: boolean, hydrate: string, sourcePath: string }`.
- `resolveIslandContext`: build keys `island_${entry.instance}_props` and
  `island_${entry.instance}_html` (was `island_${entry.id}_…`). Everything else
  (pathInto, entityEncode, ssr renderToString, contained-failure degradation) is
  unchanged. `sourcePath` still drives the dynamic import.

### `cli/native-routes-emit.ts`

- **Delete** `loadIslandConfigMap` and the `islandConfigPath` opt.
- `RawIslandEntry` / `EnrichedIslandEntry`: `id` → `{component, instance}`.
- `reconcileIslandManifest`: resolve each entry's `sourcePath` by looking up
  `entry.component` in the **page's import map**. The page source is the native
  route's component file (`importMap.get(name)` in `emitNativeTemplates`). So
  `emitNativeTemplates` scans that page file's imports (`scanImports(pagePath)`)
  and passes the resulting map to `reconcileIslandManifest`. A `component` with no
  matching import → throw `island component "X" in route "Y": no import found in
  <pagePath>` (replaces the config-membership check).
- The `{% raw %}…bootstrap…{% endraw %}` append is unchanged.

### `islands/build.ts` — `buildIslands` + new scanner

- New `scanIslandChunks(routesEntryFile: string): Map<string, string>` (name → abs
  source path):
  1. `scanImports(routesEntry)` → page modules.
  2. For each page source, regex-match `<Island\b[\s\S]*?component=\{\s*(\w+)\s*\}`
     (all occurrences) → component idents. The `\s*` inside the braces is
     load-bearing: the compiler accepts `component={ Counter }` (spaces) on the
     native path, so the React-path scanner must too — otherwise it silently emits
     no chunk and 404s at runtime.
  3. **Loud on silent miss (F3):** if a page contains a `<Island` token but the
     scan captures **no** component ident for it, throw/warn with the page path —
     never let an island silently produce no chunk. There is no compiler
     cross-check for React-path islands, so this is the only guard.
  4. Resolve each ident via that page's own `scanImports` → abs source.
  5. Build the map. Treat `name → SAME path` as a dedupe (one chunk); `name → two
     DISTINCT paths` → throw the collision error naming both files.
  - `scanImports` is currently a **private `function`** in `native-routes-emit.ts:118`
    — sharing it is a real edit (export it, or hoist to a small shared module so the
    import-resolution regex has a single source of truth). Decision in plan.
- `buildIslands` signature changes to consume a resolved map instead of reading
  config: `buildIslands(islands: Map<string,string>, options)`. The `_react.js` /
  `_react-dom.js` / `_bootstrap.js` runtime chunks are still built unconditionally.
  `isValidIslandId` (mirrors `is_safe_island_filename`) still validates each name.

### `islands/island.tsx` — React-path runtime component

- Remove the `id?` prop from `IslandProps`. `data-brust-island = Component.name`
  (server-side render → reliable, see minify note). If `Component.name` is empty
  (anonymous default export), throw the existing clear error telling the user to
  give the component a name. Update doc comment.

### `cli/build.ts`, `cli/dev.ts`, `index.ts` — wiring

- Remove all `island.config.ts` path resolution (3 sites in `index.ts`, 1 in
  `build.ts`, 1 in `dev.ts`).
- `build.ts` §3: replace the `existsSync(islandConfig)` gate with `scanIslandChunks`
  + `buildIslands(map, …)`. If the map is empty, skip (log `0 chunks`).
- `build.ts` §4.1 / `dev.ts`: drop `islandConfigPath` from the `emitNativeTemplates`
  call.
- `index.ts` lifecycle `buildIslands` closures: rebuild via the scanner.
- Update the `minify: { identifiers: false }` comment in `build.ts` (still needed —
  `Component.name` is the React-path marker — but the "no explicit id prop" phrasing
  is now the default, not a fallback).

## CLI / authoring surface (after)

- `<Island component={X} props={…} [ssr] [hydrate="…"] />` — **no `id`**.
- No `island.config.ts` anywhere (scaffolding, examples, fixtures all drop it).
- Island component must be a **named** component (named function/const) with an
  app-unique name.

## File structure (touched)

```
crates/jsx-rust-compiler/src/{ir,lower,lib,emit_jinja}.rs   # IR + lowering + manifest + emit
crates/jsx-rust-compiler/fixtures/island_{csr,ssr}.{tsx,expected.html}  # golden update
runtime/islands/{native-render,build,island}.ts             # runtime + scanner + React marker
runtime/cli/{native-routes-emit,build,dev}.ts               # reconcile + wiring
runtime/index.ts                                            # wiring (3 sites)
example/hello-world/{island.config.ts → DELETE, pages/NativeIslands.tsx}  # drop id="ClientCounter"/"ServerCounter" (44,52)
bench/apps/brust/{island.config.ts → DELETE, pages/NativeIslands.tsx}     # drop id= (20,21)
runtime/cli/templates/minimal/island.config.ts → DELETE (+ brust-new scaffolding refs)
tests/fixtures/app/island.config.ts → DELETE
tests/fixtures/app/components/{NotePage,AvatarPage,WhoAmIPage}.tsx        # React-path <Island id="…"> → drop id= (F1)
docs/superpowers/specs/2026-05-29-native-islands-design.md   # note supersession
architecture.md, example READMEs                             # drop island.config.ts mentions
```

## Tests

### Compiler (Rust) — **byte-equal goldens WILL break; update in lockstep**

- `lib.rs` unit tests: `compile_full_collects_islands_in_source_order`,
  `compile_full_no_islands_yields_empty_vec`, `island_nested_deep_in_elements_is_collected`,
  `islands_to_json_golden`, `islands_to_json_empty_is_bracket_pair` — rewrite for the
  new `IslandMeta` shape + JSON.
- **Delete** `compile_full_rejects_duplicate_island_ids`; **add**
  `compile_full_allows_duplicate_components_distinct_instances` (two `<Island component={C}>`
  → instances 0 and 1, no error).
- `emit_jinja.rs` island unit tests (`emits_ssr_island`, `emits_client_only_island`,
  `emits_island_interpolates_id_and_hydrate`) — these assert the **raw emitted jinja
  string**, which DOES change: `data-brust-island="Counter"` stays, but the context
  keys become `{{ island_0_props }}` / `{{ island_0_html }}`. Update assertions;
  rename the third (it tested id, now tests component+instance).
- **Byte-equal render goldens (B1 correction):** the island render tests are
  `renders_island_csr_byte_equal` / `renders_island_ssr_byte_equal` in
  `crates/jsx-rust-compiler/tests/golden_render_jinja/main.rs` (NOT
  `golden_emit_jinja_for_all_fixtures`, whose `FIXTURES` are islandless:
  static_hello/props_hello/list_nav). The fix is to change the `context!{}` keys in
  `main.rs` from `island_Counter_props`/`island_Counter_html` to
  `island_0_props`/`island_0_html`. **The `fixtures/island_{csr,ssr}.expected.html`
  files stay BYTE-IDENTICAL** — `data-brust-island="Counter"` is still the component
  name and the props/html values are context-supplied (already substituted in the
  fixture). Verify byte-equality after the change; do NOT regenerate the HTML.
  **These fixtures are the exact ones the Biome session corrupted — leave them
  untouched, only edit `main.rs`.**

### Runtime (TS)

- `native-render.test.ts` — `resolveIslandContext` keys are `island_<instance>_…`;
  manifest entries carry `component`/`instance`.
- `native-routes-emit.test.ts` — `reconcileIslandManifest` resolves `sourcePath`
  from a page import map (no config); collision/no-import errors.
- New `build.test.ts` (or extend) — `scanIslandChunks` resolves a multi-island,
  multi-component, reused-component page; asserts the collision error.
- `bootstrap.test.ts` — unaffected by schema (keys off DOM attrs) but re-run.
- `tests/native-island.test.ts`, `tests/native-island-ssr.test.ts`,
  `tests/integration.test.ts` — update fixtures (drop config, allow reuse), keep
  the real-server gating proof (SSR island markup ships, hydrates).
- **`runtime/cli/native-routes-emit.test.ts:20,38` (F2)** — existing cases test
  `loadIslandConfigMap`/config-map enrichment (`sourcePath:'/abs/Counter.tsx'` from
  config). These DIE when config resolution → page-import-map resolution; rewrite
  to assert import-map-based `sourcePath` + the no-import/collision errors.
- **`tests/cli-new.test.ts:180` (F2)** — asserts the scaffold emits
  `island.config.ts`; breaks when the template file is deleted. Remove/flip the
  assertion (scaffold no longer emits it).

### Acceptance criteria

1. `cargo test -p jsx-rust-compiler` green (goldens + unit, including the new
   duplicate-component-allowed test).
2. `bun test` runtime suite green (count recorded at scrutinize time; prior
   baseline was 218).
3. The Goal snippet (same component twice, one ssr, no id, no config) compiles,
   builds two-instance jinja with **one** `Counter.js` chunk, and at real-server
   level: client mount loads `Counter.js`, ssr instance ships markup + hydrates.
4. `island.config.ts` exists nowhere in the repo (grep clean).
5. `biome check` exit 0.

## Non-goals

- swc-AST-based React-page island scanning. v1 is a regex scanner, matching the
  existing `scanImports` posture (regex, AST deferred). Documented limitation.
- Per-island-instance distinct components sharing a name across files (collision →
  build error, not auto-disambiguation).
- Hot-reload of island chunks on `.tsx` edit in dev (already a pre-existing
  Non-goal; unchanged).
- `<Island>` inside `.map(...)` (already rejected; unchanged).
- Object-literal props on the native path (already a Non-goal; `props` stays a
  single path).

## Known limitations

- **App-unique island component names.** The component identifier is the chunk URL;
  two different files with same-named island components collide (clear build error).
- **Regex island scanner.** `<Island component={X}>` must be syntactically
  recognizable by regex (component prop present, `{Ident}` form — which the compiler
  already requires). Exotic formatting that splits `component={` across constructs
  is unsupported (won't occur with normal formatting; the compiler is the source of
  truth for native pages anyway).
- **Anonymous island components** (`export default () => …`) are rejected — must be
  named (pre-existing constraint, now enforced uniformly).

## Alternatives considered (rejected)

- **Folder convention (`islands/` glob → chunk per file).** Robust, no JSX scanner —
  but forces island components into a designated folder, which is "doing something
  extra" the user explicitly wanted to avoid, and splits island components from
  regular components. Rejected in favor of zero-friction inline use.
- **Keep `id=` as optional override.** Adds surface for an edge case (anonymous
  components) that's better solved by requiring a name. Rejected for simplicity.
- **Rewrite `data-brust-island` markers in-template during reconcile** (to inject a
  JS-derived hashed chunk key). More invasive in-template string surgery + brittle;
  the component-name-as-chunk-key + collision-error approach is simpler.

## Open questions resolved at plan time

- Exact error variant/message for a now-illegal `id=` attribute on `<Island>`.
- Whether `scanImports` is exported from `native-routes-emit.ts` or hoisted to a
  shared module (single source of truth either way).
- Whether `buildIslands` takes the resolved `Map` (preferred — testable) vs the
  routes entry path (scans internally).

## Scope note

This is a **large but cohesive** change: removing `island.config.ts` requires
touching the compiler manifest schema, emit, the native reconcile, the React-path
chunk build, all wiring, examples/fixtures/templates, and the byte-equal goldens —
all in lockstep, because a half-removed config leaves chunks unbuildable. It is
**not** safely decomposable into separately-shippable sub-projects (an intermediate
state where config is gone but the scanner doesn't exist yet cannot build any island
chunk). The plan sequences it so the tree stays green at each task boundary.
