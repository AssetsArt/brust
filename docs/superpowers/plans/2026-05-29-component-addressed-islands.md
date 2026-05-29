# Plan — Component-addressed islands

**Spec:** `docs/superpowers/specs/2026-05-29-component-addressed-islands-design.md`
**Base commit:** `4b9d996` (branch `feat/component-addressed-islands`)

Lockstep schema change (spec §Scope note). The tree is RED *within* a task but
GREEN at every task boundary. Tasks run in strict order; T2+ depend on the
rebuilt `jsx-rustc` binary from T1.

## Spec-coverage table

| Spec section | Task |
|---|---|
| Compiler `ir.rs` (`component`/`instance`, drop `id`) | T1 |
| Compiler `lower.rs` (charset validate, reject `id=`, drop id logic) | T1 |
| Compiler `lib.rs` (numbering pass, collect, `IslandMeta`, `islands_to_json`, error variants, drop DuplicateIslandId) | T1 |
| Compiler `emit_jinja.rs` (`data-brust-island={component}`, `island_{instance}_*`) | T1 |
| Compiler tests (unit + emit + render goldens; B1) | T1 |
| `native-render.ts` (`NativeIslandEntry`, instance keys) | T2 |
| `native-routes-emit.ts` (drop config, page-import resolution, scanImports export) | T2 |
| native-routes-emit.test.ts (F2) | T2 |
| `build.ts` scanner + `buildIslands(map)` (F3 loud-miss, collision) | T3 |
| `island.tsx` (drop `id` prop) | T3 |
| `build.ts` `build.test.ts` scanner test | T3 |
| Wiring: `cli/build.ts`, `cli/dev.ts`, `index.ts` (3 sites) | T4 |
| Examples/bench/templates/fixtures (drop `id=`, delete config) + cli-new.test (F1/F2) | T5 |
| Integration tests (native-island, -ssr, integration) | T6 |
| Docs (architecture.md, READMEs, supersession) | T7 |

---

## T1 — Compiler: component-addressed manifest + instance numbering

**Files:** `crates/jsx-rust-compiler/src/{ir,lower,lib,emit_jinja}.rs` + the in-file
tests + `crates/jsx-rust-compiler/tests/golden_render_jinja/main.rs`.

### T1.1 `ir.rs` — `JsxNode::Island`
Replace the `id` field with `component` + `instance`:
```rust
Island {
    /// Source identifier from `component={Ident}` — the chunk key.
    component: String,
    /// Source-order index within this template (set by `number_islands`).
    instance: usize,
    props_path: String,
    hydrate: String,
    ssr: bool,
},
```

### T1.2 `lower.rs` — `lower_island`
- Store the ident from `island_component_ident` as `component`.
- **Validate charset:** after extracting the ident, if it is not
  `chars().all(|c| c.is_ascii_alphanumeric() || c == '_')` (and non-empty) → return
  `LowerError::at(span, ErrorKind::IslandBadComponentName)`.
- **Reject `id=`:** in the attribute `match`, add an explicit arm BEFORE `_ => {}`:
  ```rust
  "id" => return Err(LowerError::at(jsx_attr.span, ErrorKind::IslandIdAttrRemoved)),
  ```
  (Deleting the old `id` arm alone would fall through to `_ => {}` and silently drop
  it — spec B2.) Remove the `explicit_id`/`default_id` locals and the
  `let id = explicit_id.unwrap_or(component_id);` derivation.
- Construct `JsxNode::Island { component, instance: 0, props_path, hydrate, ssr }`
  (`instance` overwritten by the numbering pass).

### T1.3 `lib.rs`
- Add the numbering pass and call it in `compile_full` after `lower`, before
  `emit`/`collect`:
  ```rust
  fn number_islands(node: &mut JsxNode, counter: &mut usize) {
      match node {
          JsxNode::Island { instance, .. } => { *instance = *counter; *counter += 1; }
          JsxNode::Element { children, .. } => {
              for c in children { number_islands(c, counter); }
          }
          JsxNode::Map { body, .. } => number_islands(body, counter),
          JsxNode::Empty | JsxNode::Text(_) | JsxNode::Expr(_) => {}
      }
  }
  ```
  In `compile_full`: `let mut ir = lower::lower(&parsed)...?;` then
  `let mut n = 0; number_islands(&mut ir.root, &mut n);` (make `ir` mut; `emit`
  takes `&ir`).
- `collect_islands`: read `component`/`instance` from the node; push into `IslandMeta`.
- `IslandMeta` → `{ component: String, instance: usize, props_path: String, ssr: bool, hydrate: String }`.
- `islands_to_json` → `{"component":"…","instance":N,"propsPath":"…","ssr":bool,"hydrate":"…"}`
  (instance is a bare number, no quotes).
- **Delete** the duplicate-id loop in `compile_full` and the `DuplicateIslandId` +
  `IslandBadId` variants. **Add** `IslandIdAttrRemoved` + `IslandBadComponentName`:
  ```rust
  #[error("`<Island id=…>` is no longer supported — islands are addressed by `component={{…}}`; remove the `id` attribute")]
  IslandIdAttrRemoved,
  #[error("`<Island component={{{0}}}>` — component name must match [A-Za-z0-9_]+ (it becomes the chunk filename and DOM marker)")]
  IslandBadComponentName(String),
  ```
  (the second carries the bad name; pass `component.clone()` at the call site).

### T1.4 `emit_jinja.rs` — island branch
Destructure `JsxNode::Island { component, instance, props_path: _, hydrate, ssr }`:
```rust
let _ = write!(out,
    "<div data-brust-island=\"{component}\" data-brust-props=\"{{{{ island_{instance}_props }}}}\" data-brust-hydrate=\"{hydrate}\"");
if *ssr {
    let _ = write!(out, ">{{{{ island_{instance}_html | safe }}}}</div>");
} else {
    out.push_str(" data-brust-csr></div>");
}
```

### T1.5 Tests (write/adjust in the same task — TDD: update expectations, then make green)
- `lib.rs`:
  - `compile_full_collects_islands_in_source_order` → expect `component`/`instance`
    (`A`→instance 0, `B`→instance 1).
  - `island_nested_deep_in_elements_is_collected` → `component:"Deep", instance:0`.
  - `islands_to_json_golden` → new JSON shape; keep the escaping case but note ids
    are now `component` (idents, no escaping needed) — keep `propsPath` escaping case.
  - `islands_to_json_empty_is_bracket_pair` → unchanged.
  - **Delete** `compile_full_rejects_duplicate_island_ids`; **add**
    `compile_full_allows_duplicate_components_distinct_instances` (two
    `<Island component={C}>` → `instance` 0 and 1, no error).
  - **Add** `lower_rejects_id_attr` and `lower_rejects_bad_component_name` (e.g.
    `component={Foo$Bar}`).
- `emit_jinja.rs`: `emits_ssr_island`/`emits_client_only_island` → `island_0_props`/
  `island_0_html`, `data-brust-island="Counter"`. Rename
  `emits_island_interpolates_id_and_hydrate` → `..._component_and_hydrate`, assert
  `data-brust-island="Cart"` + `island_0_*`.
- `tests/golden_render_jinja/main.rs` (B1): in `renders_island_csr_byte_equal` /
  `renders_island_ssr_byte_equal`, rename context keys `island_Counter_props` →
  `island_0_props`, `island_Counter_html` → `island_0_html`. **Do NOT touch the
  `.expected.html` fixtures** — they stay byte-identical.

**Verify:** `cargo test -p jsx-rust-compiler` → all green (incl. the new reject +
duplicate-allowed tests). Then rebuild the binary T2+ need:
`cargo build -p jsx-rust-compiler --bin jsx-rustc` → exit 0.

**BLOCKED fallback:** if `emit` can't take `&ir` after the mut numbering pass (borrow
issue), number into a fresh counter inside `compile_full` and pass instances via a
side `Vec` indexed by collect order — but prefer the IR-field approach; the borrow is
sequential (mutate, then immutably borrow), so it should compile.

---

## T2 — Runtime native path: instance keys + config-free reconcile

**Files:** `runtime/islands/native-render.ts`, `runtime/cli/native-routes-emit.ts`,
`runtime/cli/native-routes-emit.test.ts`, `runtime/islands/native-render.test.ts`.

### T2.1 `native-render.ts`
- `NativeIslandEntry`: `{ component: string; instance: number; propsPath: string; ssr: boolean; hydrate: string; sourcePath: string }`.
- `resolveIslandContext`: keys `island_${entry.instance}_props` and
  `island_${entry.instance}_html` (replace `entry.id`). Everything else unchanged.

### T2.2 `native-routes-emit.ts`
- **Export** `scanImports` (was private — single source of truth; spec O2).
- Delete `loadIslandConfigMap` and the `islandConfigPath` field on `NativeRouteEmitOpts`.
- `RawIslandEntry` → `{ component: string; instance: number; propsPath: string; ssr: boolean; hydrate: string }`. `EnrichedIslandEntry` adds `sourcePath`.
- In `emitNativeTemplates`, for each native route, after compile, scan the PAGE
  file's imports: `const pageImports = scanImports(sourcePath)` (sourcePath =
  `importMap.get(name)`, the page file). Pass `pageImports` to `reconcileIslandManifest`.
- `reconcileIslandManifest(jinjaPath, islandsJsonPath, pageImports: Map<string,string>, routeName)`:
  resolve each entry's `sourcePath = pageImports.get(entry.component)`; if missing →
  `throw new Error(\`island component "${entry.component}" in native route "${routeName}": no matching import in the page source\`)`. Drop the config-membership check.

### T2.3 Tests
- `native-render.test.ts`: manifests use `component`/`instance`; assert
  `island_0_props`/`island_1_props` etc.
- `native-routes-emit.test.ts` (F2): replace `loadIslandConfigMap`/config-map cases
  with page-import-map resolution; add the no-import error case.

**Verify:** `bun test runtime/islands/native-render.test.ts runtime/cli/native-routes-emit.test.ts` → green.

**BLOCKED fallback:** if a page imports its island component via a form
`scanImports`'s regex (`^import Name from '...'`) misses (named/re-export), the error
in T2.2 fires loudly with the page path — acceptable v1 (spec Limitations). Do NOT
silently skip.

---

## T3 — React path: chunk scanner + `buildIslands(map)` + drop `id` prop

**Files:** `runtime/islands/build.ts`, `runtime/islands/island.tsx`,
`runtime/islands/build.test.ts` (new or extend).

### T3.1 `island.tsx`
- Remove `id?` from `IslandProps`. `const resolvedId = id ?? Component.name` →
  `const resolvedId = Component.name`. Keep the empty-name throw (anonymous default).
  Update the doc comment (drop the `island.config.ts` reference).

### T3.2 `build.ts` — `scanIslandChunks` + `buildIslands`
- Import the shared `scanImports` from `../cli/native-routes-emit.ts`.
- New exported `scanIslandChunks(routesEntryFile: string): Map<string,string>`:
  1. `const pages = scanImports(routesEntryFile)` → page modules.
  2. For each page path, read source; for every `<Island …/>`: regex
     `/<Island\b[\s\S]*?\/>/g` to slice each tag, then within each, capture
     `/component=\{\s*(\w+)\s*\}/`. If a tag has no component capture → `throw`
     naming the page (F3 loud-miss).
  3. Resolve each ident via `scanImports(pagePath)`; missing → throw naming page+ident.
  4. Build `Map<name, path>`; `name→same path` dedupes; `name→2 distinct paths` →
     throw the collision error naming both.
- `buildIslands(islands: Map<string,string>, options)`: drop the configPath import.
  Build the 3 runtime chunks unconditionally; then `for (const [id, entry] of islands)`
  validate `isValidIslandId(id)` + `buildOne([entry], outDir, \`${id}.js\`, externals)`.
  Return `{ outDir, islandCount }`.

### T3.3 `build.test.ts`
- Fixture page with: a client island + an ssr island reusing the SAME component
  (→ 1 chunk), a second component (→ 2nd chunk). Assert the map + chunk count.
- Assert collision throw (two pages, same-named island component, distinct paths).
- Assert loud-miss throw (`<Island props={x}/>` without `component`).

**Verify:** `bun test runtime/islands/build.test.ts` → green.

**BLOCKED fallback:** if slicing `<Island …/>` via `/<Island\b[\s\S]*?\/>/g` over-
matches (a `>` inside an attribute string), fall back to matching from `<Island\b`
to the first `/>` — islands are self-closing with literal/ident attrs only (no `>`
in values per the compiler grammar), so the simple non-greedy slice is safe; document.

---

## T4 — Wiring: remove `island.config.ts` from build/dev/index

**Files:** `runtime/cli/build.ts`, `runtime/cli/dev.ts`, `runtime/index.ts`.

- `cli/build.ts` §3: replace the `existsSync(islandConfig)` block with:
  ```ts
  const { scanIslandChunks, buildIslands } = await import('../islands/build.ts')
  const islandMap = existsSync(routesFile) ? scanIslandChunks(routesFile) : new Map()
  if (islandMap.size > 0) {
    const islandsOutDir = path.join(outDir, 'islands')
    const result = await buildIslands(islandMap, { outDir: islandsOutDir })
    console.log(`[brust build] islands: ${result.islandCount} chunk(s) → ${islandsOutDir}`)
  } else { console.log('[brust build] islands: skipped (no <Island> usage)') }
  ```
  (Note: `routesFile` is computed at §4; move its computation above §3, or recompute.)
  §4.1: drop `islandConfigPath` from the `emitNativeTemplates` call.
- `cli/dev.ts`: drop the `islandConfig` var + `islandConfigPath` from
  `emitNativeTemplates`. Wire `scanIslandChunks`+`buildIslands` the same way if dev
  builds islands (mirror build.ts).
- `index.ts`: both sites (≈349, 437) — replace
  `const islandConfig = …'island.config.ts'; if (existsSync) build(islandConfig)`
  with `const islandMap = scanIslandChunks(routesEntry); if (islandMap.size) buildIslands(islandMap)`.
  Resolve the routes entry from `scanRoot` (`routes.tsx`); guard its existence.

**Verify:** `bun run build` (debug napi must exist) in `example/hello-world` boots
without referencing config; `grep -rn "island.config" runtime/` → only comments, no
live code. Defer full smoke to T6.

**BLOCKED fallback:** if `index.ts`'s lifecycle has no `routes.tsx` path handy at the
closure, reuse the same `scanRoot`/entry resolution the native-emit path uses
(`routes.tsx` under scanRoot); if absent, empty map (no islands).

---

## T5 — Examples / bench / templates / fixtures cleanup

**Delete:** `example/hello-world/island.config.ts`, `bench/apps/brust/island.config.ts`,
`runtime/cli/templates/minimal/island.config.ts`, `tests/fixtures/app/island.config.ts`.

**Edit (drop `id=`):**
- `example/hello-world/pages/NativeIslands.tsx:44,52` and
  `bench/apps/brust/pages/NativeIslands.tsx:20,21`: remove `id="ClientCounter"` /
  `id="ServerCounter"` → just `<Island component={Counter} props={…} [ssr] hydrate="load" />`.
  Update the doc comment (the dual-id explanation is now obsolete; note both are the
  same `Counter` chunk, distinguished by instance + ssr).
- `tests/fixtures/app/components/{NotePage,AvatarPage,WhoAmIPage}.tsx`: drop the
  `id="…"` attr (id equals the component name, so this is semantically a no-op).
- `brust-new` scaffolding: remove any code that writes `island.config.ts`
  (grep `island.config` under `runtime/cli/` for the scaffold writer).

**Edit (tests):**
- `tests/cli-new.test.ts:180` (F2): remove/flip the assertion that the scaffold emits
  `island.config.ts`.

**Verify:** `grep -rn "island.config" --include=*.ts --include=*.tsx .` → no live
references (comments/docs only); `bun test tests/cli-new.test.ts` → green.

---

## T6 — Integration tests + real-server proof

**Files:** `tests/native-island.test.ts`, `tests/native-island-ssr.test.ts`,
`tests/integration.test.ts` (+ their fixtures).

- Update fixtures to drop config + allow reuse.
- Keep the real-server gating proof: native route with TWO islands reusing `Counter`
  (one client-only, one ssr) → assert one `Counter.js` chunk served, ssr instance's
  `<button>` markup ships in HTML, client instance is empty `data-brust-csr`, both
  hydrate. This is acceptance criterion §3.
- Per memory `native-island-integration-flake`: run integration + cli-build files
  **separately** (combined `bun run` has a ~1/5 port-race flake).

**Verify (run separately):**
`bun test tests/native-island.test.ts` ; `bun test tests/native-island-ssr.test.ts` ;
`bun test tests/integration.test.ts` — each green. Requires `cd runtime && bun run build:debug` (napi) + the T1 `jsx-rustc` binary.

**BLOCKED fallback:** a single flaky port-race failure on the combined run is NOT a
real failure (memory) — re-run the file alone 2×; only a deterministic failure blocks.

---

## T7 — Docs

- `architecture.md`: drop `island.config.ts` from the islands description; document
  component-addressing (chunk = component name, instance = source order) + the
  app-unique-name limitation.
- `example/hello-world/README.md` (+ any bench README): remove `island.config.ts`
  mentions.
- `docs/superpowers/specs/2026-05-29-native-islands-design.md`: add a one-line
  supersession note pointing to this spec for the id/config mechanism.

**Verify:** `grep -rn "island.config" *.md docs/ example/ --include=*.md` → only the
supersession/historical mentions remain.

---

## Final gate (Phase 6 will re-run all of these)
1. `cargo test -p jsx-rust-compiler` green.
2. `cargo build -p jsx-rust-compiler --bin jsx-rustc` exit 0.
3. `cd runtime && bun run build:debug` (napi) exit 0.
4. Runtime + integration suites green (files run separately per flake memory).
5. `biome check` exit 0.
6. `grep -rn "island.config"` → no live code references.
7. Real-server two-instance reuse proof passes (acceptance §3).
