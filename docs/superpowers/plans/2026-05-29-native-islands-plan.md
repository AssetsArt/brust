# Plan — Islands in the native (jinja) render path

**Spec:** `docs/superpowers/specs/2026-05-29-native-islands-design.md` (gating Qs resolved)
**Branch:** `design/native-islands`
**Date:** 2026-05-29
**Shape:** TDD, bite-sized. Three milestones. Milestone 1 ships a working
client-only island; Milestone 2 adds `ssr`. Milestone 0 is the shared compiler
foundation both need.

## Architectural decisions locked from code inspection (refine the spec)

These were verified against the actual code before planning; the plan builds on
them:

1. **Compiler API.** `compile_with_path` returns `String` (`lib.rs:10`). Add
   `compile_full(source, path) -> Result<Compiled, CompileError>` where
   `Compiled { template: String, islands: Vec<IslandMeta> }`. Keep
   `compile`/`compile_with_path` as thin wrappers returning `.template` (golden
   harness + existing callers unchanged).
2. **Manifest flow.** The Rust compiler does NOT know `island.config.ts`. It
   emits a RAW manifest `[{id, propsPath, ssr, hydrate}]`. The `jsx-rustc` bin
   writes `<out>.islands.json` next to the `.jinja` when islands are present.
   The TS build step (`native-routes-emit.ts`) then VALIDATES every id ∈
   `island.config.ts` keys and ENRICHES each entry with `sourcePath` (from the
   config) → final `<Name>.islands.json` = `[{id, propsPath, ssr, hydrate, sourcePath}]`.
   The worker reads `sourcePath` directly (no runtime threading of island.config).
3. **Bootstrap baking.** The TS build step APPENDS `ISLANDS_IMPORTMAP_AND_BOOTSTRAP`
   (single source: `importmap.ts`) to the emitted `.jinja` content when the route
   has ≥1 island. Rust never learns the markup. (`<script type=module defer>`
   executes post-parse regardless of position, so end-of-file is correct.)
4. **Props path.** `propsPath` is a single segment string (`"counter"`).
   `pathInto(data, propsPath)` splits on `.` for forward-compat but v1 emits
   single-segment only.
5. **bootstrap mode detect.** Use the `data-brust-csr` attribute (compiler emits
   it on client-only islands) → `createRoot`; else `hydrateRoot`. Both tracked in
   `islandRoots` WeakMap.

## Spec-coverage table

| Spec section | Task(s) |
|---|---|
| Compiler — `<Island>` recognition, IR node, prop-path extraction | T1 |
| Compiler — emit mount marker + ssr slot + `data-brust-csr` | T2 |
| Compiler — per-route manifest emission | T3 |
| Compiler golden (client-only + ssr) | T4 |
| Runtime bootstrap — createRoot/hydrateRoot auto-detect + unmount parity | T5 |
| Build pipeline — registry validation, manifest enrich, bootstrap bake | T6 |
| Runtime native branch — manifest load, propsPath, attr-safe props, context merge (client-only) | T7 |
| Integration — client-only island (response shape + browser smoke) | T8 |
| Runtime native branch — ssr renderToString, JSON-roundtrip invariant, contained failure | T9 |
| Integration — ssr island (SSR markup, no hydration-mismatch, browser smoke) | T10 |
| Bench probe + no-island byte-identical regression | T11 |

---

## Milestone 0 — Compiler foundation (shared)

### T1 — IR `Island` node + `<Island>` lowering

**Files:** `crates/jsx-rust-compiler/src/ir.rs`, `src/lower.rs`, `src/lib.rs`

**Test first** (`lower.rs` `#[cfg(test)]`):
- `<Island component={Counter} props={data.counter} hydrate="visible" ssr />`
  on a component with `data` destructured → `JsxNode::Island { id: "Counter",
  props_path: "counter", hydrate: "visible", ssr: true }`.
- `<Island component={Counter} props={counter} />` (counter destructured) →
  `{ id: "Counter", props_path: "counter", hydrate: "load", ssr: false }`.
- Explicit `id="x"` overrides the component-name default.
- Deep path `props={data.a.b}` → clear error (`IslandPropsPathTooDeep` or reuse
  `UnresolvedIdent`-style). Missing `component` → error. `props` that isn't a
  member/ident → error.
- Event handler INSIDE a normal element still rejected (unchanged); a `<Island>`
  is NOT routed through `lower_element_name` rejection.

**Implementation:**
- `ir.rs`: add to `JsxNode`:
  ```rust
  Island {
      id: String,
      props_path: String,
      hydrate: String,
      ssr: bool,
  },
  ```
- `lower.rs` `lower_element` (line 223): at the very top, before
  `lower_element_name`, peek the opening name; if it's `JSXElementName::Ident`
  with sym `"Island"`, return `lower_island(el, scope)?`. (This bypasses the
  `CustomComponentNotSupported` rejection at `lower_element_name:300-307`.)
- New `fn lower_island(el, scope) -> Result<JsxNode, LowerError>`:
  - Walk `el.opening.attrs`; recognize `component` (JSXExprContainer → Ident →
    its sym is the default id), `id` (Str literal → overrides id), `props`
    (JSXExprContainer → extract path via a dedicated walker, NOT `lower_expr`),
    `hydrate` (Str literal, default `"load"`; validate ∈ load/idle/visible/interaction),
    `ssr` (bare boolean attr presence → true).
  - Prop-path extraction: accept `Ident(x)` where `x ∈ scope.destructured` →
    path `x`; or `Member` exactly one deep off a destructured root
    (`data.counter` where `data ∈ destructured`) → path = leaf seg. Reuse the
    chain-walk shape from `lower_member` (line 716) but cap depth at 1 and
    return the path string. Deeper / unresolved → error.
  - `component` must be present (else error). `id = explicit_id ?? component_ident`.
- `lib.rs`: add `ErrorKind` variants as needed (`IslandMissingComponent`,
  `IslandPropsPathUnsupported`, `IslandBadHydrate`). The existing
  `EventHandlerNotSupported` message mentioning "Phase A3" can stay.

**Verify:** `cargo test -p jsx-rust-compiler --lib` green incl. new tests.

**BLOCKED fallback:** if extracting the `component` ident proves entangled with
swc attr shapes, simplify v1 to REQUIRE explicit `id="..."` and treat `component`
as opaque (don't read it) — the id is all the compiler needs; the source path
comes from island.config at build time anyway.

---

### T2 — emit `<Island>` → jinja mount marker

**Files:** `crates/jsx-rust-compiler/src/emit_jinja.rs`

**Test first** (`emit_jinja.rs` `#[cfg(test)]`, byte-equal on `emit`):
- ssr island `Island { id:"Counter", props_path:"counter", hydrate:"load", ssr:true }`
  →
  ```
  <div data-brust-island="Counter" data-brust-props="{{ island_Counter_props }}" data-brust-hydrate="load">{{ island_Counter_html | safe }}</div>
  ```
- client-only (`ssr:false`) →
  ```
  <div data-brust-island="Counter" data-brust-props="{{ island_Counter_props }}" data-brust-hydrate="load" data-brust-csr></div>
  ```
  (no `_html` slot, `data-brust-csr` present.)

**Implementation:** add a `JsxNode::Island { .. }` arm to `emit_node` (line 24).
Build the `<div>` with the attributes above using `write!`. The
`island_<id>_props` / `island_<id>_html` context keys interpolate the
build/runtime-supplied strings. `| safe` is available (default builtins); props
attr is NOT `| tojson` (unavailable) — it reads the pre-serialized string.

**Verify:** `cargo test -p jsx-rust-compiler --lib`.

---

### T3 — compiler emits manifest; `jsx-rustc` writes `.islands.json`

**Files:** `crates/jsx-rust-compiler/src/lib.rs`, `src/bin/jsx-rustc.rs`,
new `src/manifest.rs` (or inline in lib).

**Test first** (`lib.rs` tests): `compile_full(src, path)` on a fixture with one
ssr + one client-only island returns `Compiled { template, islands }` where
`islands == [{id, props_path, ssr, hydrate}, ...]` in source order; a no-island
source returns `islands: vec![]`.

**Implementation:**
- `IslandMeta { id, props_path, ssr, hydrate }` (serde `Serialize`; add `serde`
  +`serde_json` to the compiler crate if not present — check `Cargo.toml`).
- A post-lower walk collects `JsxNode::Island` nodes into `Vec<IslandMeta>`
  (walk the IR tree; islands can be nested inside elements/maps).
- `compile_full` returns both; `compile_with_path` = `compile_full(...).map(|c| c.template)`.
- `jsx-rustc.rs`: after writing `<out>`, if `!islands.is_empty()` write
  `serde_json::to_string(&islands)` to `<out>` with `.jinja`→`.islands.json`
  (or `<out>.islands.json`). Keep `--check` behavior.

**Verify:** `cargo test -p jsx-rust-compiler --lib`; manual
`jsx-rustc fixture.tsx -o /tmp/x.jinja && cat /tmp/x.islands.json`.

**BLOCKED fallback:** if adding serde to the compiler crate is undesirable, emit
the manifest as hand-rolled JSON (the shape is trivial: 4 flat fields, strings +
one bool). No new dep.

---

### T4 — compiler golden fixtures (client-only + ssr)

**Files:** `crates/jsx-rust-compiler/tests/golden_render_jinja/main.rs` +
`fixtures/island_csr.tsx` / `.expected.html`, `fixtures/island_ssr.tsx` / `.expected.html`.

**Test first:** two new `#[test]` fns rendering the fixtures through minijinja
with a context supplying `island_Counter_props` (+ `island_Counter_html` for
ssr) and asserting byte-equality. Mirror the harness at `main.rs:7-29`.

**Implementation:** author the fixtures + expected files. Render with
`UndefinedBehavior::Chainable` (matches harness). Confirm the `| safe` filter
passes the html slot through unescaped.

**Verify:** `cargo test -p jsx-rust-compiler --test golden_render_jinja`.

---

## Milestone 1 — Client-only island (ships working end-to-end)

### T5 — bootstrap `createRoot` / `hydrateRoot` auto-detect + unmount parity

**Files:** `runtime/islands/bootstrap.ts`, `runtime/islands/bootstrap.test.ts`
(or existing test file).

**Test first** (bun): a marker with `data-brust-csr` → `hydrateOne` calls
`createRoot(el).render(...)`; a marker WITHOUT it (populated) → `hydrateRoot`.
`unmountIslandsIn` unmounts both kinds. (Mock `react-dom/client` to spy on which
fn is invoked.)

**Implementation:** `bootstrap.ts:16` add `createRoot` to the import. In
`hydrateOne` (line 74): after resolving `Component`, branch on
`el.hasAttribute('data-brust-csr')`:
```ts
const root = el.hasAttribute('data-brust-csr')
  ? (createRoot(el), then render) // createRoot(el); root.render(createElement(Component, props))
  : hydrateRoot(el, createElement(Component, props))
islandRoots.set(el, root)
```
(`createRoot` returns a `Root` with `.unmount()`, same as `hydrateRoot`, so
`unmountIslandsIn` at line 102 already works once the root is in the WeakMap.)

**Verify:** `bun test runtime/islands/`.

---

### T6 — build pipeline: validate ids, enrich manifest, bake bootstrap

**Files:** `runtime/cli/native-routes-emit.ts`, its test.

**Test first** (bun): given a native route emitting `<Name>.islands.json` with
ids `["Counter"]` and an `island.config.ts` exposing `Counter`, after
`emitNativeTemplates`: (a) the final `<Name>.islands.json` entries carry
`sourcePath` resolved from the config; (b) the `<Name>.jinja` ends with
`ISLANDS_IMPORTMAP_AND_BOOTSTRAP`; (c) an id NOT in island.config throws a clear
error; (d) a route with no islands writes no `.islands.json` and the `.jinja` is
byte-identical to today (no bootstrap appended).

**Implementation:** after the `jsx-rustc` spawn (line ~63) for each route:
- read `<out>.islands.json` if present;
- load island.config.ts (reuse `buildIslands`'s config-load shape, or accept the
  resolved `Record<id,sourcePath>` as an opt param — prefer passing it in from
  the caller that already loaded it for `buildIslands`);
- validate each id ∈ config keys (throw `island "<id>" in native route "<Name>"
  is not registered in island.config.ts`);
- enrich entries with `sourcePath`, rewrite the `.islands.json`;
- append `ISLANDS_IMPORTMAP_AND_BOOTSTRAP` to the `.jinja` file content.
- Import `ISLANDS_IMPORTMAP_AND_BOOTSTRAP` from `runtime/islands/importmap.ts`.

**Verify:** `bun test runtime/cli/`.

**BLOCKED fallback:** if wiring the resolved island.config into
`emitNativeTemplates` is awkward, have it load `island.config.ts` itself via
dynamic import (the function is async already) keyed off `scanRoot`.

---

### T7 — native branch: manifest load + props (client-only path)

**Files:** `runtime/routes.ts` (native branch, lines 548-585), helper module
`runtime/islands/native-render.ts` (new), test.

**Test first** (bun unit on the helper): `resolveIslandContext(manifest,
loaderData)` returns `{ island_Counter_props: '<entity-safe json>' }` for a
client-only manifest entry with `propsPath:"counter"` and
`loaderData:{counter:{n:1}}`; the props string is `JSON.stringify` then
entity-encoded (`&<>"`); NO `island_Counter_html` key for client-only.

**Implementation:**
- `native-render.ts`: `pathInto(data, propsPath)`, `entityEncode(s)`
  (`&`→`&amp;` first, then `<>"`), `resolveIslandContext(manifest, data,
  importer)` returning the extra context keys. Client-only entries (`!ssr`)
  contribute only `_props`.
- `routes.ts` native branch: after `data = await leaf.loader(...)` (line 554),
  load the route manifest (cache by template name; `null` if no `.islands.json`),
  JSON-roundtrip `data` once (`const rt = JSON.parse(json)` reusing the `json`
  already computed at line 564), compute `const extra =
  resolveIslandContext(manifest, rt, importer)`, merge `const ctx = manifest ?
  { ...rt, ...extra } : data`, then `JSON.stringify(ctx)` into the SAB instead of
  the bare `json` (only when manifest present — keep the no-island path
  byte-identical).

**Verify:** `bun test runtime/`.

---

### T8 — integration: client-only island

**Files:** `tests/` new test (mirror `tests/jinja-route.test.ts`), a fixture
native route using a client-only `<Island>`, browser smoke (Playwright per
existing island tests).

**Test first:** request the native route → response HTML contains the empty
marker `<div data-brust-island="..." data-brust-props="..." data-brust-csr>`
(no inner markup) + the bootstrap script; browser smoke: load page, click the
island button, assert it became interactive (counter increments).

**Verify:** `bun test tests/`. **Milestone 1 complete — client-only ships.**

---

## Milestone 2 — Server island (`ssr`)

### T9 — native branch: ssr renderToString + invariants

**Files:** `runtime/islands/native-render.ts`, `runtime/routes.ts`, test.

**Test first** (bun unit): `resolveIslandContext` with an `ssr` entry +
`importer` stub returning a component → produces `island_X_html` =
`renderToString(createElement(Component, jsonRoundtrippedProps))` AND
`island_X_props`. Invariant test: server render uses the JSON-roundtripped value
(feed a `Date`/`undefined`-bearing object; assert server html matches what the
client would get from `JSON.parse(props)`). Contained-failure test: an importer
/ renderToString that throws → entry degrades to client-only (emits `_props`,
no `_html`, logs) — does NOT throw out of `resolveIslandContext`.

**Implementation:**
- `importer(sourcePath)`: `await import(sourcePath)` → `mod.default ?? mod`;
  cache by path (Bun's module registry already caches; a Map is belt-and-braces).
- For `ssr` entries: `try { Component = await importer(entry.sourcePath);
  html = renderToString(createElement(Component, props)) } catch (e) {
  console.error(...); /* fall through: no _html, keep _props */ }`.
- `props` is `pathInto(rt, propsPath)` from the SAME roundtripped object → byte
  identity with `data-brust-props`.
- `routes.ts`: the native branch now `await`s `resolveIslandContext` (it became
  async for the import). NOTE: the native branch is currently sync after the
  loader; `resolveIslandContext` is async, but the loader `await` is already
  there — this stays inside the existing crossing, no new napi hop. Import
  `renderToString` is already at `routes.ts:2`.

**Verify:** `bun test runtime/`.

**BLOCKED fallback (the gating-Q1 risk):** if importing the island's `.tsx`
source in the worker drags a browser-only dep that throws at module-eval (not
render), the contained-failure path catches the RENDER throw but not an IMPORT
throw at module top-level — wrap the `import()` in the same try/catch (it is) so
an import failure also degrades to client-only. If degradation proves too
silent for SEO-critical islands, surface a build-time warning when an ssr
island's source imports a known browser-only module. Do NOT 500 the page.

---

### T10 — integration: ssr island

**Files:** `tests/`, fixture ssr `<Island>`, browser smoke.

**Test first:** request → response HTML has SSR markup INSIDE the marker
(`<div data-brust-island=...>...rendered...</div>`, no `data-brust-csr`);
browser smoke: no React hydration-mismatch warning in console, island
interactive after hydration.

**Verify:** `bun test tests/`.

---

### T11 — bench probe + no-island regression

**Files:** bench harness (per `README`/bench), `tests/jinja-route.test.ts`
(existing, must stay green).

**Test first / checks:**
- `tests/jinja-route.test.ts` (native, no islands) green — byte-identical
  response (acceptance #5).
- React-path island tests green (untouched).
- A new bench probe: `/native-profile/World` no-island unchanged at ~60k floor;
  a native-with-island route documents its cost. **Reason in deltas, verify
  fresh** (per `[[brust-perf-bench-caveats]]`; macOS≠Linux). Do NOT claim a
  number without a fresh same-session run.

**Verify:** `bun test tests/`; `bun run bench` (document, don't gate on absolute
numbers).

---

## Acceptance criteria (from spec §Acceptance)

1. `cargo test -p jsx-rust-compiler` green incl. T1-T4. ✅ gate on T4.
2. `bun test runtime/` + `bun test tests/` green; no regression in native or
   React-path island tests. ✅ gate on T8 (M1) + T10 (M2).
3. Client-only island: empty marker + props + bootstrap; interactive after load. → T8.
4. ssr island: SSR markup in marker; no hydration-mismatch; interactive. → T10.
5. No-island native route byte-identical to today. → T7 (no-island path
   untouched) + T11 regression.
6. Bench: no-island unchanged at floor; island probe documented. → T11.

## Known limitations carried from spec
CSS-on-native-island (Non-goal v1), no dev hot-reload for native islands, single
propsPath only, synchronous renderToString (no Suspense), client-only flashes
empty. All documented in the spec's Known Limitations.
