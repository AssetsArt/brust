# m3f-store-compiler — `useStore` as a native-tier intrinsic: store-view roots, store-derived precompute slots, manifest `stores`, ssr `__store` input

**RULED by lead Detoro 2026-10-11 (before dispatch): R1 ACCEPTED (fallbacks `store-key-unsupported`, `store-handle-in-render`; spec §2.3 amended). R2 ACCEPTED (every Ssr job declares `__store`; island jobs also `props["__store"] = "__store"`; the worker strip is relayed to the server lane; spec C5 amended). R3 ACCEPTED (dotted names → coarse `__store` input) PLUS a compiler warning `store-name-dotted`; the dogfood store will be named `team` (dot-free) — add that warning as a golden. R4 ACCEPTED (same-module store → `store-name-unresolved`, remediation text as written). R5 ACCEPTED (`state_dependent = true` for store-derived slots; spec wording replaced). Server-lane relays filed by the lead: strip `inputs.__store` before React render; keep `__store` in the `"*"`/all_props input object even though it is hidden from `_props` (island x-props).**
owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · base: m3f (worktree ~/code/brust-m3f) · lane: m3f-store-compiler · tier: complex · review: complex

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land spec §2.3 + D7 + contracts C3/C5/C6 of `docs/design/2026-10-11-m3f-unified-store-design.md` in the compiler (base `m3f` @ 3342353). After this lane:
- `const s = useStore(cart)` (and `const { count } = useStore(cart)`) in a native component is recognised by import identity. `s.count` paints as `{{ __store.cart.count | e }}` in the template and reads `cart.count()` in the client chunk, so the binding updates live.
- A derived value over store reads (`fmt(s.count)`) is a precompute slot whose `inputs` carry `__store.cart.count`; the job key moves with the value, and the chunk recomputes it as a `computed`.
- `<name>` comes from `defineStore('<lit>', …)` in the handle's module (relative imports, re-exports followed). Anything that cannot be proven falls back to tier `react` with a golden diagnostic. A wrong value is never painted.
- The manifest carries `components[id].stores` (C3), and every ssr job declares `__store` (C5).

Everything not named here (worker scope, protocol, `__store` in ctx, the script tag, bundling, runtime store API) belongs to `m3f-store-server` / `m3f-store-core`, which run in parallel against C1–C8.

**Tech stack:** Rust nightly-2026-09-15, `bun_ast` @ 620b50f (`SLocal{is_export}`, `SExportClause`, `SExportFrom{items, import_record_index}`, `SExportStar{import_record_index}`, `ClauseItem{alias, name, original_name}` — `~/.cargo/git/checkouts/bun-563be9f2e1ee56a8/620b50f/src/ast/{s.rs:48-87,nodes.rs:572-590}`), minijinja 3 via `brust-jinja`, Bun canary (dual_eval, battery), happy-dom (browser-test).

## Reading order

1. `docs/design/2026-10-11-m3f-unified-store-design.md` — D1–D10 and C1–C8 are FIXED. Read §2.3, D7, D8, C3, C5, C6 twice.
2. `docs/design/2026-10-08-react-compiler-design.md` §4.3 (hook table), §5.1 (placements), §6.2 (subset), §6.3–6.4 (seeding, precompute), §7.1/§7.3 (chunk, client imports), §8.1 (diagnostic classes).
3. Analysis:
   - `crates/brust-compiler/src/analyze/hooks.rs`: `hook_target` :92-105, `mark_state_bindings` :113-137, `read_decl` :336-476 (hook arms :354-459), `read_expr_stmt` :498-539.
   - `analyze/names.rs`: `NameTable` :10-25, imports map :35-57, `kind_of` :165-194.
   - `analyze/expr.rs`: the `props.x` → `Ident{Prop}` collapse :76-93 (the precedent for the store-view collapse), `module_scope` :313-366.
   - `analyze/component.rs`: `cache` recognised by import :194-198; `read_function` :321-385 (`mark_state_bindings` call :329).
   - `analyze/jsx.rs:44`: `Outlet` recognised by import.
   - `analyze/modules.rs`: `ModuleCache` :21-26, `resolve` :169-190 (the relative-import resolver you reuse), `normalize` :194-216.
4. Passes:
   - `passes/mod.rs`: `run_passes` :83-107 (note `minimal_paths` at :100-106 collapses `["*", x]` to `["*"]`).
   - `passes/deps.rs`: `Deps` :23-53, `minimal_paths` :70-82, `DepsCx::new` :103-126, `client_view` :133-155, `deps_expr` :174-186, `prop_path` :229-244, `ident` :323-352, `expr` :395-401.
   - `passes/placement.rs`: job assembly :146-176, `slot` :395-432, `painted` :435-447, `If` guards :613-622, `For` lists :640-655.
   - `passes/tier.rs`: static decision :67-77, the React ssr job `inputs: ["*"]` :89-101.
   - `passes/children.rs`: `fed` :281-286, `reads_state` :332-339, island-prop error :457-472, `InstanceRecord` :534-546, `instance_needs_link` :670-683.
   - `passes/captures.rs`: `client_props` / `client_imports` :159-166.
   - `passes/server_expr.rs:29-36` (subset ident kinds).
5. Lowering:
   - `lower/template.rs`: `names()` :212-257, `reactive` :325-345, list `directive_row` :905-913, island hosts print x-props from the node's props, not the job's :1112-1157, `x-props` / `_props` :623-640, `expr_reactive` :1482-1489.
   - `lower/server_expr.rs`: `member_access` :45-60, ident :103-112.
   - `lower/common.rs`: `imports_in` :216-222, `module_code` :251-288, `client_js` :310-323, `client_ident` :337-350, `server_js` :360-374, `wrap_source` :378-424.
   - `lower/client.rs`: imports :46-53, decls :56-102, runtime import :236-241.
   - `lower/server.rs:107` (`precompute(props)`).
   - `ir/expr.rs`: `IdentKind` :7-17, `Expr::Precomputed` :139-148, print ident :335-357.
   - `ir/mod.rs`: `ComponentIR` :185-240, `new` :261-291.
   - `ir/decls.rs`: `JobDecl` :62-79, `InstanceRecord` :97-108.
6. Server facts you depend on but do not edit:
   - `crates/brust-server/src/inputs.rs`: `Path::parse` splits on `.` :30-64; `PropsMap::eval` inserts `Null` for a missing path :218-229.
   - `manifest.rs`: `ALL_PROPS` :108; child-job `UncoveredInput` check :392-403.
   - `pipeline.rs`: `job_tpl` (`"*"` → All, `props` → PropsMap) :1381-1388; `all_props` :1401-1412; `props_view`/`PROPS_HIDDEN` :870-877.
   - `packages/brust/src/build/bundle.ts:41-55`: `sourceDirPlugin` resolves a chunk's relative imports against the component's SOURCE dir.
7. Build + tests:
   - `packages/brust/src/build/manifest.ts` (`ComponentRecord` :34-42, `writeManifest` :214-258, `linkNativeChunks` :266-292) and `compile.ts` (`ComponentIR` type :13-24, normalisation :121-124).
   - `crates/brust-compiler/tests/{fixtures.rs,dual_eval.rs,lower_template.rs,tier.rs,lower_common/mod.rs}`, `tests/harness/{eval.ts,rt.ts}`, `tests/fixtures/{README.md,theme-toggle/,product-card/}`, `scripts/battery/{rows.ts,exit.ts,run.ts,exit.test.ts}`.

## Global constraints

**Rulings requested from the lead before dispatch.** Each has a default; the implementer follows it unless the lead answers differently.
- **R1 — two more Fallback rules.** §2.3 names `store-name-unresolved` and `store-write-in-render`. Two shapes need their own rule, or the result is a wrong first paint or a 500:
  - `store-key-unsupported`: render reads a key that is not a top-level `signal(…)` of the factory (a `computed`, a plain value, an action, an unreadable factory), or the bare view `s`. C1 serialises signals only (D1 `serialize()`), so the server has no value for such a key.
  - `store-handle-in-render`: render code reaches a store handle import directly (`{cart.count()}`). That becomes a precompute slot whose job calls the handle in the worker outside a store scope (D8: jobs never see stores), and the job throws.
  - Default: ACCEPT.
- **R2 — C5 on island jobs.** C5 names the `"*"` object. An island job inside a route component carries a `props` map instead, and the server ignores `inputs` when `props` is set (`pipeline.rs:1381-1388`).
  - Default: every `JobKind::Ssr` gets `"__store"` in `inputs`; an island job also gets `props["__store"] = "__store"`, so `PropsMap` puts the snapshot (or `null`) into `inputs` and the key hashes it.
  - The worker must strip `inputs.__store` before handing props to the React component. That is a server-lane note: the lead relays it.
  - Default: ACCEPT.
- **R3 — store names or keys containing `.` or `[`** (`'pokedex.team'`, the D10 dogfood name) cannot be job-input paths, because `Path::parse` splits on `.` (`inputs.rs:30-64`). Default: such a read declares the coarse input `__store`, which hashes the whole snapshot. The key stays correct and only the granularity drops. Alternative (rejected here): a quoted-key path syntax, which would change the server contract.
- **R4 — same-module stores** (`defineStore` in the component's own file) → `store-name-unresolved`. D4's worker touches `stores` modules, and touching a `.tsx` component module would pull React into the loader path. Default: ACCEPT, with the remediation "define the store in its own module".
- **R5 — reading of "`state_dependent` stays false for the server" (§2.3).** In the IR, `Expr::Precomputed.state_dependent` (`ir/expr.rs:136-147`) is the "client recomputes `client_js`" bit. Template directives, the tier and the client imports all key off it (`template.rs:334`, `tier.rs:105-120`, `captures.rs:141-150`). A store-dependent slot therefore sets it to `true`. The server job is unchanged: it reads the store value from its inputs, never from a seed. Default: ACCEPT, no rename.
- **Coordination (no ruling for this lane, relay to `m3f-store-server`):** once `__store` is in ctx, `props_view` (`pipeline.rs:870-877`) shows it in `_props`. `_props` feeds `x-props='{{ _props | json_attr }}'` of whole-props native hosts (`template.rs:623-640`) and of React root islands (`lower/mod.rs:98-108`). If the server hides it there, `all_props` (`:1401-1412`) must keep it for C5.

**Lane setup and workflow:**
- Lane: `cd ~/code/brust-m3f && git pull --ff-only && git worktree add ../brust-lane-m3f-store-compiler -b lane/m3f-store-compiler m3f` (NOT `conclave lane start`, which branches from `main`). Run `bun install --frozen-lockfile` once. Line numbers are at 3342353; if code moved, re-anchor on the quoted text and say so in the task note.
- NO PR. READY goes on the Conclave task and the lead merges into `m3f`. ONE PR `m3f → v2` runs at the end of M3-F.
- TDD with goldens. Every behaviour lands red first:
  - a failing test in `crates/brust-compiler/tests/store.rs` (new);
  - a fixture golden, created with `BRUSTC_UPDATE=1 cargo test -p brust-compiler --test fixtures` and then READ line by line against the task's assertions before committing.
- Existing goldens must not change, except in Task 8 (C5: exactly the nine ssr fixtures listed there and `packages/brust/test/fixtures/app.expected-manifest.json`). A golden diff anywhere else is a bug in your change.
- The coverage reports `docs/react-coverage.md` and `docs/plans/m1-exit-report.md` are GENERATED. Never hand-edit them: regenerate with `bun run battery` and commit the output with the rows that changed it (Task 10).
- **The jsx reject-guard trap** (0.1.x memory `jsx-compiler-reject-guard-depth`): every walker that refuses a shape must walk the WHOLE subtree, including `RawKind::Jsx` nodes inside expressions, `Arrow` bodies passed as call arguments, `Opaque` captures and template children. A walker that stops early lets the refused shape through to lowering.
- After ANY Rust edit, rebuild the addon before a TS test: `cd packages/brust && bun run build:debug` (a stale `native/*.node` silently uses the old compiler).
- Never `git add -A`; stage files by name. Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Gates** (green before each code commit; all of them before READY):
- `cargo fmt --all -- --check`
- `cargo clippy -p brust-compiler -p brust-compiler-cli --no-deps -- -D warnings`
- `cargo test -p brust-compiler` (includes `fixtures`, `dual_eval`, `store`)
- `bun run battery && git diff --exit-code docs/react-coverage.md docs/plans/m1-exit-report.md`
- `bun test scripts/battery`
- `bun run browser-test`
- Tasks 5, 7, 8 and READY also run:
  - `cargo test -p brust-server --test store_job_keys --test inputs --test manifest`
  - `cd packages/brust && bun run build:debug && bun run typecheck && bun test test/build-manifest.test.ts test/build-manifest-stores.test.ts test/build-compile.test.ts test/napi-compile.test.ts && bun test --timeout 120000 test/e2e.test.ts`
  - `bun test --timeout 120000 tests/server/pokedex.test.ts` (byte-identical: no pokedex route touches a store)

## Boundary (exact)

**Modify:**
- `crates/brust-compiler/src/ir/{expr.rs,decls.rs,mod.rs}`
- `crates/brust-compiler/src/analyze/{names.rs,hooks.rs,expr.rs,component.rs,modules.rs}`
- `crates/brust-compiler/src/analyze/passes/{mod.rs,deps.rs,placement.rs,tier.rs,children.rs,server_expr.rs}`
- `crates/brust-compiler/src/lower/{common.rs,client.rs,template.rs}`
- `crates/brust-compiler/tests/{dual_eval.rs,harness/eval.ts}`
- the nine C5 fixtures' `expected.ir.json` (Task 8 only), `tests/fixtures/README.md`
- `packages/brust/src/build/{manifest.ts,compile.ts}`, `packages/brust/test/build-manifest.test.ts`, `packages/brust/test/fixtures/app.expected-manifest.json`
- `scripts/battery/{rows.ts,exit.ts}`, plus the two generated reports

**Create:**
- `crates/brust-compiler/src/analyze/stores.rs` (module reader, Bun side)
- `crates/brust-compiler/src/analyze/passes/stores.rs` (resolve + render checks)
- `crates/brust-compiler/tests/store.rs`
- `crates/brust-compiler/tests/harness/store.ts` (dual-eval store shim)
- `tests/fixtures/{store-read,store-derived,store-handler-write,store-unresolved-fallback}/` (input, store modules, samples, goldens)
- `crates/brust-server/tests/store_job_keys.rs` (test only, no src)
- `packages/brust/test/build-manifest-stores.test.ts`

**Not touched (other lanes):**
- `packages/runtime-dom/**`, `packages/brust/src/{worker.ts,store/**,build/bundle.ts}`, `packages/brust/package.json`
- `crates/brust-server/src/**`, `crates/brust-napi/**`, `crates/brust-jinja/**`
- `examples/**`, `tests/server/**`, `bench/**`

## Tasks

### Task 1: IR shapes + `useStore` recognition (arity, argument, binding)

**Files:** `ir/expr.rs`, `ir/decls.rs`, `ir/mod.rs`, `analyze/names.rs`, `analyze/hooks.rs`, `analyze/expr.rs`, `analyze/component.rs`; create `tests/store.rs`.

- [ ] **Step 1: Failing tests** in `tests/store.rs`. Helper `analyze_at(case, src)` = `analyze_source(&format!("tests/fixtures/{case}/T.tsx"), src, &AnalyzeOptions { root: repo(), ..Default::default() })` inside `run_on_compiler_thread`. Cases (source starts with `import { useStore } from 'brust/store/react'\nimport { cart } from './cart'\n`):
  - `use_store_view`: `const s = useStore(cart); return <p>{s.count}</p>`.
    - `ir.stores.len() == 1`, `view == Some("s")`, `handle == "cart"`, `import == ("cart","./cart","cart")`.
    - The structural slot is `Ident { name: "s.count", kind: Store { handle: "cart", key: Some("count") } }`.
  - `use_store_destructure`: `const { count, items: list } = useStore(cart)` → `fields == [("count","count"),("items","list")]`, `view == None`; a read of `list` is `Store{handle:"cart", key:Some("items")}`.
  - `use_store_alias`: `import { useStore as useS } from '@brust/core/store/react'` is recognised. `import { useStore } from 'zustand'` keeps today's `hook-unsupported` fallback.
  - `use_store_shapes`:
    - `useStore()` → Fallback `hook-shape`; `useStore(cart, 1)` → `hook-shape`; `const [a] = useStore(cart)` → `hook-shape`;
    - `useStore(props.h)` → Fallback `store-name-unresolved`;
    - `const n = useStore(cart).count` → `hook-unsupported` (unchanged nested-hook rule, hooks.rs:309-334);
    - a bare statement `useStore(cart)` → `hook-shape` "useStore result must be bound".
  - `use_store_namespace`: `import * as stores from './stores'` + `useStore(stores.cart)` → `handle == "stores.cart"`, `import == ("stores","./stores","*")`. Write this test first. If Bun's parser rewrites `ns.member` into an `EImportIdentifier` that `NameTable::import_of` cannot trace (esbuild's `import_items_for_namespace`), assert `store-name-unresolved` instead and record the AST shape in the task note: fail closed, never guess.
  - Run `cargo test -p brust-compiler --test store` → compile errors / failures.
- [ ] **Step 2: IR.**
```rust
// ir/expr.rs, IdentKind (after LoopBinding):
/// A store read through `useStore` (M3-F D7). `handle` is the handle as written in this module
/// (`cart`, `stores.cart`: what the chunk calls); `key` is the member read (`s.count`, or a
/// destructured `{ count }`), `None` for the whole view `s`.
Store { handle: String, key: Option<String> },

// ir/decls.rs:
/// One `useStore(handle)` binding of the component (M3-F D7).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct StoreUse {
    pub handle: String,
    /// The import that brings the handle in: (local, source, imported); `*` for a namespace.
    pub import: (String, String, String),
    /// `s` of `const s = useStore(h)`; `None` for a destructuring.
    pub view: Option<String>,
    /// `(key, local)` of `const { key: local } = useStore(h)`, source order.
    pub fields: Vec<(String, String)>,
    pub loc: u32,
    /// Filled by the stores pass (Task 2); `None` = unresolved (the component falls back).
    pub resolved: Option<StoreRef>,
}
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct StoreRef {
    /// The `defineStore` literal.
    pub name: String,
    /// Root-relative path of the module that CALLS defineStore (C3; after re-exports).
    pub module: String,
    /// Top-level keys of the factory's returned object, sorted.
    pub signals: Vec<String>,
    pub computeds: Vec<String>,
    /// The factory's returned object was read (keys above are complete).
    pub factory_read: bool,
}
```
  `ComponentIR` gains `#[serde(default, skip_serializing_if = "Vec::is_empty")] pub stores: Vec<StoreUse>` after `children`, and `stores: vec![]` in `new`. Every existing `expected.ir.json` stays byte-identical.
  Fix every exhaustive `match` on `IdentKind` that the compiler names. `deps.rs` `ident` gets a temporary `IdentKind::Store { .. } => out.opaque = true` that Task 3 replaces.
- [ ] **Step 3: NameTable.** Add `stores: HashMap<u32, (String, Option<String>)>`, `pub fn mark_store(&mut self, r: Ref, handle: String, key: Option<String>)`, and `pub fn store_view(&self, r: Ref) -> Option<&str>` (only for `key == None`). In `kind_of`, a branch after `setters`: `else if let Some((h, k)) = self.stores.get(&k) { IdentKind::Store { handle: h.clone(), key: k.clone() } }`.
- [ ] **Step 4: Recognition** in `hooks.rs`:
```rust
/// Specifiers `useStore` is recognised from (C6; `brust/store/react` is the compiler-test form).
pub const USE_STORE_SOURCES: &[&str] =
    &["@brust/core/store/react", "@brust/runtime-dom/store/react", "brust/store/react"];
/// The callee is `useStore` from one of USE_STORE_SOURCES, by import identity (an alias included).
pub fn is_use_store(target: &js_ast::Expr, names: &NameTable<'_>) -> bool;
/// The handle argument: an import binding (`cart`), or a member of a namespace import
/// (`stores.cart`), with (local, source, imported). `None` for anything else.
pub fn store_handle(arg: &js_ast::Expr, names: &NameTable<'_>) -> Option<(String, (String, String, String))>;
```
  - Extend `mark_state_bindings` (single entry point; its four call sites — component.rs:206, :329, :559, :575 — then get store marking for free). For `const <BIdentifier> = useStore(h)` call `mark_store(id, handle, None)`. For `const { k, k2: l } = useStore(h)` with only plain string keys bound to `BIdentifier`s (no spread, no default, no nesting) call `mark_store(local, handle, Some(key))`.
  - In `read_decl`, BEFORE `match (from_react, hook.as_str())` (:354): `if is_use_store(&call.target, r.names) { return read_use_store(r, out, decl, &args, vloc) }`.
    - Arity ≠ 1 → `out.fallback("hook-shape", "useStore takes one store handle", …)`.
    - Handle `None` → `out.fallback("store-name-unresolved", "useStore(…): the argument is not an imported store handle; the component renders as a React island", vloc, "pass the handle imported from the module that calls defineStore('<name>', …)")`.
    - A binding shape other than the two above → `hook-shape` "useStore result must be bound to a const or destructured one level deep".
    - Otherwise push `StoreUse { resolved: None, .. }` to a new `BodyDecls.stores`. `component.rs` `read_function` copies it into `ir.stores`.
  - In `read_expr_stmt`, a bare `useStore(…)` statement → `hook-shape` "useStore result must be bound".
- [ ] **Step 5: Collapse** in `expr.rs` EDot (:76), mirroring the `props.x` arm: when `d.target` is an `EIdentifier` with `names.store_view(ref) == Some(h)`, produce `RawKind::Ident { name: format!("{view}.{member}"), kind: IdentKind::Store { handle: h.into(), key: Some(member) } }`. Treat `s?.count` the same, since the view is never nullish. `s["count"]` (an `EIndex` with an `EString` index, non-optional) collapses the same way.
- [ ] **Step 6:** `cargo test -p brust-compiler` → all green (no fixture uses `useStore` yet). Commit `feat(compiler): useStore recognised as a native intrinsic (M3-F D7) — IR StoreUse + IdentKind::Store`.

### Task 2: Resolve `<name>` from `defineStore('<lit>', …)` through the handle's import

**Files:** create `analyze/stores.rs` and `analyze/passes/stores.rs`; modify `analyze/modules.rs` (cache fields), `analyze/names.rs` (factor out the import map), `analyze/mod.rs` / `passes/mod.rs` (module lines, call order).

- [ ] **Step 1: Failing tests** in `tests/store.rs`, each writing modules into a fresh temp root (`std::env::temp_dir().join(format!("brustc-store-{}-{n}", std::process::id()))`) and analysing `C.tsx` there with `AnalyzeOptions { root }`. `resolved` must equal `StoreRef { name: "cart", module: "<file>", signals: ["count"], .. }` for:
  1. `export const cart = defineStore('cart', () => ({ count: signal(0) }))`;
  2. a block factory `() => { const count = signal(0); const dbl = computed(() => count() * 2); return { count, dbl } }` (`computeds: ["dbl"]`);
  3. `const c = defineStore(…); export { c as cart }`;
  4. `export default defineStore(…)` imported as `import cart from './cart'`;
  5. `export { cart } from './inner'` in `stores/index.ts` (module = `stores/inner.ts`);
  6. `export * from './inner'`;
  7. `import { cart } from './inner'; export { cart }`;
  8. `import { defineStore as ds } from '@brust/core/store'`;
  9. `defineStore` from `@brust/runtime-dom`;
  10. a no-substitution template-literal name.

  `resolved == None` plus exactly one Fallback `store-name-unresolved` whose message names the reason for:
  - `defineStore(prefix + 'cart', …)` ("is not a string literal");
  - `defineStore('a b', …)` ("is not [A-Za-z0-9_.:-]+", D6);
  - a handle from the package `shop-stores` ("is imported from the package");
  - `./missing` ("cannot resolve");
  - a module without that export;
  - `defineStore` from `zustand`;
  - a re-export cycle `a.ts ⇄ b.ts` (terminates);
  - a same-module store (R4).

  Factory `() => makeStore()` → `factory_read: false`, `signals: []`. An action key `add: (n) => count.set(n)` is neither a signal nor a computed. Two modules defining `'cart'` in one tree → one Warning `store-name-duplicate`.
- [ ] **Step 2: Module reader** (`analyze/stores.rs`, Bun-AST side):
```rust
/// Specifiers `defineStore`/`signal`/`computed` are recognised from (C6 + the runtime-dom re-exports).
pub const STORE_API_SOURCES: &[&str] =
    &["@brust/core/store", "@brust/runtime-dom/store", "@brust/runtime-dom", "brust/store"];
/// `export` of the module at root-relative `path` as a store; follows `export {…} from`,
/// `export * from` and import-then-export clauses (depth ≤ 8, `(path, export)` visited set).
pub fn read_store_export(path: &str, export: &str, opts: &AnalyzeOptions,
                         modules: &RefCell<ModuleCache>) -> Result<StoreRef, String>;
```
  - Parse with `crate::parse::parse_tsx(path, bytes)` and read with `Parsed::with_ast`.
  - Imports come from a new `pub fn module_imports(ast) -> HashMap<u32, (String, String)>`, factored out of `NameTable::new` (:35-57) so both share it.
  - Resolve relative sources with `modules::resolve(path, source, opts)`.
  - Cache results in `ModuleCache` by `(path, export)`: new fields `store_exports: HashMap<(String, String), Result<StoreRef, String>>` and `store_names: BTreeMap<String, String>` (name → module, for the duplicate warning).
  - The factory is the second argument: an `EArrow`/`EFunction` whose body returns an `EObject`. That is either the expression body (single `SReturn`, as `hooks.rs::expr_body` :488-496) or the last `SReturn` of a block whose `SLocal` consts map locals to `signal(…)`/`computed(…)` calls of STORE_API_SOURCES imports.
  - Property values: a direct call, or an `EIdentifier` (shorthand included) bound to one. Anything else is an "other" key.
- [ ] **Step 3: Pass** (`analyze/passes/stores.rs::resolve(ir, ctx)`), the FIRST statement of `run_passes` (before `PassState::new`, because `DepsCx` reads `ir.stores`).
  - For each `StoreUse`, the export is `import.2`, or the member of `handle` when `import.2 == "*"`.
  - A non-relative `import.1` → Err "the handle is imported from the package {source}".
  - Otherwise `resolve(ctx.path, source, ctx.opts)` then `read_store_export`.
  - `Ok` → `resolved = Some(..)`, and warn `store-name-duplicate` if `store_names[name]` is another module.
  - `Err(reason)` → `Diagnostic::fallback("store-name-unresolved", format!("useStore({handle}): {reason}; the component renders as a React island"), use.loc, "import the handle from the module that calls defineStore('<name>', …) with a string-literal name")`.
  - Run `finish_diagnostics` as today; the tier pass then makes it React (`tier.rs:53-61`).
- [ ] **Step 4:** `cargo test -p brust-compiler` green. Commit `feat(compiler): resolve store names from defineStore literals through imports and re-exports (M3-F D7)`.

### Task 3: Store-view roots — server path (template subset, jinja, job JS, deps)

**Files:** `passes/server_expr.rs`, `passes/deps.rs`, `lower/common.rs`, `lower/template.rs`, `tests/store.rs`; create `tests/fixtures/store-read/cart.ts` (final content, Task 9 adds the input).

- [ ] **Step 1: Fixture module** `tests/fixtures/store-read/cart.ts`:
```ts
import { defineStore, signal } from 'brust/store'

export const cart = defineStore('cart', () => {
  const count = signal(0)
  return { count }
})
```
  A directory without `input.tsx` is ignored by `fixtures.rs:57-66` and `dual_eval.rs:51-59`.
- [ ] **Step 2: Failing tests.** `lower_at(case, src)` mirrors `tests/lower_template.rs:14-31` with path `tests/fixtures/{case}/T.tsx`. Renders use `brust_jinja::register`.
  - `store_read_paints_server_path`: `const s = useStore(cart); return <p>{s.count}</p>`.
    - The jinja contains `{{ __store.cart.count | e }}`.
    - Rendered with `{"__store":{"cart":{"count":3}}}`, the output contains `>3</p>`.
    - No `x-props` attribute (C1 never reaches props).
  - `store_read_destructured`: `const { count } = useStore(cart)` → same text.
  - `store_name_with_dot`: with a temp module defining `'pokedex.team'` → `__store["pokedex.team"].members` (via `member_access`, server_expr.rs:45-60).
  - `ir.client_props` never contains `__store` (assert on the IR).
- [ ] **Step 3: Deps.**
  - `Deps` gains `pub stores: BTreeSet<String>` (job-input paths), merged in `union`, plus:
```rust
/// Reads something that changes on the client after first paint (state or a store).
pub fn reactive(&self) -> bool { !self.state.is_empty() || !self.stores.is_empty() }
```
  - `DepsCx` gains `stores: HashMap<String, StoreRef>` (handle → resolved), built in `new` from `ir.stores`.
  - Store input paths:
```rust
/// Job-input path of a store read (R3): `__store.<name>.<key>`, `__store.<name>` for the whole view,
/// or `__store` when a segment contains `.`/`[`/`]` or is empty (inputs::Path splits on `.`).
pub fn store_input(name: Option<&str>, key: Option<&str>) -> String
```
  - In `Walker::ident` (:323), `IdentKind::Store { handle, key }` inserts `store_input(name, key)` into `out.stores` (an unresolved handle gives `__store`). It also inserts the handle's `(source, imported)` from `ir.stores` into `out.imports`, so `client_imports` and the `server-only-in-client` check (captures.rs:174-194) cover the store module.
  - Add `pub fn split_inputs(inputs: &[String]) -> Deps`: `__store`/`__store.*` go to `stores`, the rest to `props`. Use it in `DepsCx::new` (:111-114), `client_view` (:145-149), `deps_expr` (:177-180) and `Walker::expr` (:398), which today put every precomputed input into `props`.
- [ ] **Step 4: Subset + printers.**
  - `server_expr.rs:32`: accept `IdentKind::Store { key: Some(_), .. }` (a bare view stays outside the subset).
  - `lower/common.rs`: add `Facts.stores: HashMap<String, &StoreUse>` (by handle) and the printers:
```rust
/// `__store.cart.count` / `__store["pokedex.team"].members` (jinja).
pub fn store_jinja(name: &str, key: Option<&str>) -> String;   // member_access over member_access("__store", name)
/// Precompute job (D7: inputs carry the value; jobs never import a store module).
pub fn store_server_js(name: &str, key: Option<&str>) -> String; // `(props.__store?.["cart"] ?? {}).count`
```
  - `template.rs` `names()` gains `IdentKind::Store { handle, key } => Some(store_jinja(name_of(handle), key))`, with no instance suffix: store paths are global, so an inlined child prints the same text. An unresolved handle prints `UNDEFINED` (never lowered: tier React).
  - The `server_js` closure (common.rs:367-372) gains the same arm through `store_server_js`.
- [ ] **Step 5:** tests green; existing goldens unchanged (`cargo test -p brust-compiler --test fixtures`). Commit `feat(compiler): store-view reads paint __store.<name>.<key> in the template subset (M3-F D7)`.

### Task 4: Store-view roots — client chunk (signal reads, imports, view object, tier)

**Files:** `ir/expr.rs` (default client print), `lower/common.rs`, `lower/client.rs`, `lower/template.rs`, `passes/placement.rs` (`painted`), `passes/tier.rs`, `tests/store.rs`.

- [ ] **Step 1: Failing tests.**
  - `store_read_chunk`, same source as Task 3:
    - the chunk contains `import { cart } from "./cart"` and `const _c1 = computed(() => __text(cart.count()))`;
    - the template carries `x-text="_c1"`;
    - `ir.tier == Tier::Native`: a component whose only dynamic value is a store read is not Static;
    - the chunk contains no `snapshot`.
  - `store_handler_reads`: `onClick={() => cart.count.set(s.count + 1)}` → the handler prints `cart.count.set(cart.count() + 1)`.
  - `store_block_handler_view`: `onDoubleClick={() => { const n = s.count * 2; cart.count.set(n) }}` → the chunk declares `const s = { get count() { return cart.count() } }` once, and the verbatim body is NOT re-bound for `s` in `wrap_source`.
  - `store_destructured_in_block`: `const { count } = useStore(cart)` + a block handler reading `count` → `wrap_source` binds `count` to `cart.count()` at call time (like state, common.rs:399).
  - `store_non_signal_key_in_handler`: an action key `s.add` in a handler prints `cart.snapshot()["add"]` (React-equivalent: a snapshot drops functions). A computed key `s.dbl` prints `cart.dbl()`.
  - `store_namespace_handle`: `stores.cart.count()` plus `import * as stores from "./stores"`.
- [ ] **Step 2: Printing.**
  - Default `print` (ir/expr.rs:338-357), `JsCtx::Client`, for `Store { handle, key: Some(k) }` → `{handle}.{k}()` (`{handle}[{js_string(k)}]()` when `!is_js_ident(k)`), and `key: None` → `{handle}.snapshot()`. Make `is_js_ident` `pub(crate)`. Server-ctx default prints `name` (IR text only: lowering always goes through `server_js`).
  - `client_ident` (common.rs:337) gains the authoritative arm: a key in `signals ∪ computeds` → `{handle}.{k}()`; any other key → `{handle}.snapshot()[{js_string(k)}]`; `None` → `{handle}.snapshot()`.
  - `wrap_source` (:386-409):
    - `Store { key: None }` captures → `continue` (the chunk const is in scope);
    - `Store { key: Some(_) }` captures → `(name, client_ident(..))`.
- [ ] **Step 3: Chunk.**
  - In `client.rs` after :50, for every `Store` ident reached by `roots ∪ reached_raws` (use `visit_idents`, captures included), insert `ir.stores[handle].import` into `imports`. The import keeps the user's specifier. `sourceDirPlugin` (bundle.ts:41-55) resolves it against the component's source dir, i.e. the store module's project path (C6). The job (`server.rs`) never imports it.
  - For each `StoreUse` with `view: Some(v)` captured by a verbatim root (`Arrow{Block}`/`Opaque` captures), push `(use.loc, format!("const {v} = {{ {} }}", getters))` with `get k() {{ return {handle}.k() }}` per key of `signals ∪ computeds`, sorted. If `factory_read == false`, Task 6 has already refused the component.
- [ ] **Step 4: Reactivity.**
  - Replace the state-only reactivity checks with `Deps::reactive()`:
    - `template.rs:334` (`sd`), `:912` (`directive_row`), `:1487` (`expr_reactive`);
    - `placement.rs:441` (`painted` → `client_uses`, `what: "a store-dependent value"` when only stores);
    - `children.rs:118` (`lists` stateful), `:337` (`reads_state`), `:673` (`instance_needs_link`).
  - `children.rs:457`: a store value passed to a React island is the same `island-prop` Error, with the message suffix "a reactive value (reads store `{path}`)".
  - `tier.rs:67`: add `&& !ir.stores.iter().any(|s| s.resolved.is_some())` to the Static condition.
- [ ] **Step 5:** `cargo test -p brust-compiler` green, existing goldens unchanged. Commit `feat(compiler): store reads are live signal reads in the client chunk (M3-F D7)`.

### Task 5: Derived values over store reads — precompute slots with `__store` inputs + client `computed`

**Files:** `passes/placement.rs`, `tests/store.rs`; create `tests/fixtures/store-derived/{cart.ts,fmt.ts}` and `crates/brust-server/tests/store_job_keys.rs`.

- [ ] **Step 1: Fixture modules.** `store-derived/cart.ts` is identical to store-read's. `store-derived/fmt.ts`:
```ts
export const fmt = (n: number, unit: string) => `${(n * 2.5).toFixed(2)} ${unit}`
```
- [ ] **Step 2: Failing tests.**
  - `store_derived_slot`: `const s = useStore(cart); const total = fmt(s.count, unit); return <p>{total}</p>` (prop `unit`).
    - The derived is `Precomputed { inputs: ["__store.cart.count", "unit"], state_dependent: true, client_js: Some(..) }` (R5); the job's `inputs` are the same.
    - The job text contains `const total = fmt((props.__store?.["cart"] ?? {}).count, unit)` and no `import { cart }`.
    - The chunk contains `computed(() => fmt(cart.count(), props().unit))`, the template an `x-text`.
  - `store_guard_in_key`: `{s.open ? <b>{fmt(price, 'x')}</b> : null}` (a `ui` store) → the slot's inputs include `__store.ui.open` (F33: the guard is in the key).
  - `store_list_in_key`: `{s.items.map((i) => <li key={i.id}>{fmt(i.p, 'x')}</li>)}` → the per-item slot's inputs include `__store.cart.items`; the list is client-updated (`x-for`).
  - `store_dotted_coarse`: a `'pokedex.team'` store → inputs `["__store", …]` (R3).
  - `store_job_keys.rs` (brust-server test file, no src change), with `brust_server::inputs::{Projection, job_key}` and `brust_jinja::ctx::Node`:
    - `Projection::new(&["__store.cart.count".into(), "unit".into()])` evaluated on two ctxs that differ only in `__store.cart.count` → different `job_key`s;
    - differing only in `__store.cart.other` → equal keys;
    - `["__store"]` (coarse) with `other` changed → different keys;
    - `__store` absent → `Node::Null` path, a key that differs from count = 0.
- [ ] **Step 3: Placement.**
  - `slot` (:395-432): `inputs.extend(deps.stores)`; `let mut state_dependent = deps.reactive();`.
  - Seeds (:157-166): also `inputs.extend(deps_expr(..).stores)`.
  - `If` guard (:613-618): the guard set is `props ∪ stores`.
  - `For` (:640-655): `List.paths` = `prop_paths() ∪ stores`, `stateful: src_deps.reactive() || …`.
  - `minimal_paths` is unchanged (`__store` covers `__store.*`; `*` still covers all: for a chain component `All` includes ctx `__store`, for a fed child Task 8 maps `__store`).
- [ ] **Step 4:** tests + `cargo test -p brust-server --test store_job_keys` green; existing goldens unchanged. Commit `feat(compiler): store-derived values are precompute slots keyed by __store paths, recomputed on the client (M3-F D7)`.

### Task 6: Render checks — `store-write-in-render`, `store-handle-in-render`, `store-key-unsupported`

**Files:** `passes/stores.rs` (second function, called right after `resolve`), `tests/store.rs`.

- [ ] **Step 1: Failing tests.** Each case → tier React, exactly one Fallback of the rule, and the line of the offending expression:
  - `const n = cart.count.set(1)` (never read) → `store-write-in-render`;
  - `{s.count.set(2)}` → `store-write-in-render`;
  - `const f = () => cart.count.set(1)` + `{f()}` → `store-write-in-render`;
  - `{[1].map(() => cart.count.set(1))}` → `store-write-in-render` (an arrow passed as a call argument runs in render);
  - `{cart.count()}` → `store-handle-in-render`;
  - `{s.dbl}` (computed) / `{s.add}` (action) / `{s}` / `{JSON.stringify(s)}` / a factory with `factory_read: false` and `{s.count}` → `store-key-unsupported`;
  - a block handler capturing `s` of an unread factory → `store-key-unsupported`.
  
  NOT flagged (stay native):
  - `onClick={() => cart.count.set(1)}`;
  - `const inc = () => cart.count.set(1)` + `onClick={inc}`;
  - `<Child onAdd={() => cart.count.set(1)} />`;
  - `useEffect(() => { cart.count.set(0) }, [])`;
  - a write inside JSX nested in a handler.
- [ ] **Step 2: Walker** (whole subtree; reject-guard rule).
  - **Roots** (React runs them during render):
    - every template expression except `Attr::Event` and function-valued `Component` props (`Slot`, `Dynamic`, `Spread`, `If.cond`, `For.source/key`);
    - every structural derived value whose raw is not a function (`common::is_function_raw`);
    - every state init and ref init.
  - **Descend into:**
    - `Jsx` nodes;
    - `Arrow` bodies and `Opaque` captures when the arrow/opaque is a CALL ARGUMENT;
    - the body of a derived function when it is CALLED (`Call { callee: Ident Local f }`);
    - a derived value read as an identifier.
  - **Checks:**
    - (a) `Call { callee: Member { target: T, name: "set" } }` where `T` is `Member{Ident Import h,…}` with `h` a store handle, or `Ident Store{key:Some}` → `store-write-in-render`;
    - (b) any other `Ident Import` (also in `Opaque`/`Block` captures of a root) whose relative `(source, imported)` resolves through `read_store_export` → `store-handle-in-render`;
    - (c) `Ident Store { key: None }` → `store-key-unsupported` "render uses the whole store view `{v}`";
    - (d) `Ident Store { key: Some(k) }` with `k ∉ signals` (or `!factory_read`) → `store-key-unsupported` "render reads `{v}.{k}`, which is not a signal of store `{name}`" (C1 serialises signals only);
    - (e) verbatim handler/effect captures of a view whose store has `!factory_read` → `store-key-unsupported`.
  - One diagnostic per rule per component (first loc), like `placement.rs` `flagged`. Remediations:
    - "write stores in event handlers or effects";
    - "read store values through const s = useStore(handle)";
    - "read signals as s.<key> in render; derive other values from them".
  - Statement-level writes (`cart.count.set(1);` in the body) keep today's `body-shape` fallback (hooks.rs:532-537), unchanged.
- [ ] **Step 3:** tests green; existing goldens unchanged. Commit `feat(compiler): store writes/handle reads/non-signal keys in render fall back to React (M3-F D7, R1)`.

### Task 7: Manifest `components[id].stores` (C3)

**Files:** `packages/brust/src/build/{manifest.ts,compile.ts}`, `packages/brust/test/build-manifest.test.ts` (pin regenerated), `packages/brust/test/fixtures/app.expected-manifest.json`; create `packages/brust/test/build-manifest-stores.test.ts`.

- [ ] **Step 1: Failing test** `build-manifest-stores.test.ts`, on a hand-built `Map<string, Compiled>` (IR JSON objects, no bundling — the store API is not merged yet):
  - page P (stores `stores/cart.ts`) inlines native child N (stores `stores/ui.ts`, `stores/cart.ts`) and island I (stores `stores/team.ts`);
  - a second page Q has no stores;
  - an unresolved `StoreUse` contributes nothing.
  
  Assert:
  - `storesOf(compiled, P) === ['stores/cart.ts', 'stores/team.ts', 'stores/ui.ts']`;
  - `storesOf(compiled, Q) === []`;
  - cycles terminate;
  - `writeManifest(...)` puts `stores` on every component record.
- [ ] **Step 2:** `compile.ts:13-24` adds `stores?: { handle: string; resolved: { name: string; module: string } | null }[]`; normalise `ir.stores ??= []` (:121-124). `manifest.ts`:
```ts
/** C3: root-relative modules of every store this component reads at render — its own and every
 * descendant's through `ir.children` (inlined children render in this template; an island's SSR
 * reads its stores too, D8) — sorted, unique. The worker unions it over the chain (D4). */
export function storesOf(compiled: Map<string, Compiled>, id: string): string[]
```
  `ComponentRecord` gains `stores: string[]` after `use_id_slots`. `writeManifest` fills it for every component (`[]` when none). The Rust `ComponentRecord` has no `deny_unknown_fields` (`crates/brust-server/src/manifest.rs:56`), so `Manifest::load` is unaffected until the server lane reads the field.
- [ ] **Step 3:** `cd packages/brust && bun run build:debug && BRUST_UPDATE_PIN=1 bun test test/build-manifest.test.ts`. The pin diff must be ONLY `"stores": []` lines. Rerun without the env, then run the TS gates. Commit `feat(build): manifest components[id].stores (M3-F C3)`.

### Task 8: ssr jobs declare `__store` (C5) + fed children map it

**Files:** `passes/mod.rs`, `passes/children.rs`, `tests/store.rs`; goldens `tests/fixtures/{arrow-default,client-only,import-cycle,jsx-shapes,lazy-import,react-child,react-child-nested,react-hook,react-child-row}/expected.ir.json`; `packages/brust/test/build-manifest.test.ts` (:59, :62, :69, :129-130, :140) and the pin.

- [ ] **Step 1: Failing tests.**
  - `ssr_job_declares_store`: a React-tier component's job `inputs == ["*", "__store"]` (it survives `minimal_paths`).
  - An island child job: `inputs` contains `"__store"` and `props["__store"] == Some("__store")`; `literals` unchanged.
  - A fed native child that reads a store (a precompute job over `s.count`): its `InstanceRecord.props["__store"] == Some("__store")`.
  - A fed child without stores: no `__store` key.
- [ ] **Step 2: Code.**
  - In `run_passes`, AFTER the normalisation loop (:100-106), because `minimal_paths` returns `["*"]` when `*` is present (deps.rs:72-74):
```rust
// C5 (M3-F D8): every ssr job declares the store snapshot; an island's props map carries it
// (the server evaluates `props`, not `inputs`, when it is set).
for j in ir.jobs.iter_mut().filter(|j| matches!(j.kind, JobKind::Ssr { .. })) {
    if !j.inputs.iter().any(|i| i == "__store") { j.inputs.push("__store".into()); j.inputs.sort(); }
    if let Some(p) = j.props.as_mut() { p.insert("__store".into(), Some("__store".into())); }
}
```
  - `children.rs`: `Child` gains `stores: bool` (in `finish` :281: `ir.stores.iter().any(|s| s.resolved.is_some())`). The record at :535-545 inserts `("__store", Some("__store"))` when `child.fed && child.stores`. Otherwise `Manifest::load` refuses the child job input root `__store` (`UncoveredInput`, manifest.rs:392-403). Fed children only sit under a chain component (manifest.ts:280-283), whose props ARE the ctx, so the path `__store` is right.
- [ ] **Step 3: Goldens.**
  - `BRUSTC_UPDATE=1 cargo test -p brust-compiler --test fixtures`, then `git diff --stat`: exactly the nine `expected.ir.json` above. Each hunk adds `"__store"` to an `Ssr` job's `inputs` and, on island jobs, one `"__store": "__store"` entry in `props`.
  - `BRUST_UPDATE_PIN=1` for the manifest pin.
  - Update the six TS assertions (arrays are exact under `toMatchObject`), e.g. `inputs: ['__store', 'team']`, `props: { team: 'team', __store: '__store' }`, `inputs: ['*', '__store']`.
  - Rendered HTML is unchanged: island x-props come from the node's props (`template.rs:1112-1157`), not the job's.
  - Run every gate, including e2e and pokedex.
  - Commit `feat(compiler): ssr jobs declare __store; fed children map it (M3-F C5)`.

### Task 9: Fixtures + dual evaluation with a seeded `__store`

**Files:**
- create `tests/fixtures/store-read/{input.tsx,sample-props.json}`, `store-derived/{input.tsx,sample-props.json}`, `store-handler-write/{input.tsx,cart.ts,sample-props.json}`, `store-unresolved-fallback/{input.tsx,dyn.ts}`, all `expected.*`;
- create `crates/brust-compiler/tests/harness/store.ts`;
- modify `tests/dual_eval.rs`, `tests/harness/eval.ts`, `tests/fixtures/README.md`.

- [ ] **Step 1: Inputs.**
  - `store-read/input.tsx`: `export default function CartBadge() { const s = useStore(cart); return <span className="badge">{s.count}</span> }`.
  - `store-derived/input.tsx`: the Task 5 source as `CartTotal({ unit }: { unit: string })`.
  - `store-handler-write/input.tsx`: `AddToCart({ step })` with `onClick={() => cart.count.set(s.count + step)}`, the block `onDoubleClick` of Task 4 and the text `Add ({s.count})`.
  - `store-unresolved-fallback/dyn.ts`:
```ts
import { defineStore, signal } from 'brust/store'
const prefix = 'shop.'
export const cart = defineStore(prefix + 'cart', () => ({ count: signal(0) }))
```
    with `input.tsx` = CartBadge importing `./dyn`.
  - Samples:
    - store-read `{"__store":{"cart":{"count":3}}}`;
    - store-derived `{"unit":"EUR","__store":{"cart":{"count":3}}}` (paints `7.50 EUR`);
    - store-handler-write `{"step":2,"__store":{"cart":{"count":5}}}`.
- [ ] **Step 2: Goldens.** Run `BRUSTC_UPDATE=1 cargo test -p brust-compiler --test fixtures`, then read every new file:
  - `store-read/expected.jinja`: `{{ __store.cart.count | e }}` + `x-text`, no `x-props`.
  - `expected.client.js`: `import { cart } from "./cart"`, `cart.count()`.
  - `store-derived/expected.server.ts`: `export const inputs = ["__store.cart.count", "unit"] as const` and `(props.__store?.["cart"] ?? {}).count`.
  - `store-handler-write/expected.client.js`: `const s = { get count() { return cart.count() } }`, `cart.count.set(cart.count() + props().step)`.
  - `store-unresolved-fallback`: `expected.diag.txt` = one `fallback store-name-unresolved tests/fixtures/store-unresolved-fallback/input.tsx:L:C useStore(cart): the name passed to defineStore in tests/fixtures/store-unresolved-fallback/dyn.ts is not a string literal; …` line; `expected.jinja` = the `<brust-island … x-props='{{ _props | json_attr }}'>{{ _ssr_… | safe }}</brust-island>` host; `expected.ir.json` ssr `inputs: ["*", "__store"]`; no `expected.client.js`.
- [ ] **Step 3: Harness.**
  - `tests/harness/store.ts`:
```ts
// Dual-evaluation stand-in for @brust/core/store (the real one lands with m3f-store-core): the same
// reactive core as the chunks (rt.ts), seeded from the sample's `__store` like the client registry
// seeds from <script data-brust-store> (D6).
import { computed, signal } from '../../../../packages/runtime-dom/src/index.ts'
export { computed, signal }
export function defineStore(name: string, factory: () => Record<string, any>) {
  const inst = factory()
  const seed = (globalThis as any).__BRUST_DUAL_STORE__?.[name] ?? {}
  for (const [k, v] of Object.entries(seed)) if (typeof inst[k]?.set === 'function') inst[k].set(v)
  return Object.defineProperty({ ...inst, snapshot: () => Object.fromEntries(Object.entries(inst).map(([k, x]) => [k, typeof x === 'function' && 'set' in x ? x() : x])) }, 'name', { value: name })
}
```
  - `dual_eval.rs` `build()` (:124-131): when copying a fixture `.ts`, replace the specifiers `'brust/store'` / `"brust/store"` with the JSON-quoted absolute path of `harness/store.ts`.
  - Pass the sample as the 4th argument of `check` (:212-218).
  - `eval.ts`: `const [cmd, a, b, c] = …`, and in `check`, BEFORE the chunk-import loop (:27), set `globalThis.__BRUST_DUAL_STORE__ = c ? (JSON.parse(await Bun.file(c).text()).__store ?? {}) : {}`.
  - The template ctx already includes `__store`, because the sample is the ctx (:193-200).
  - The job gets the sample as `props` (:181-188).
  - Add `"store-unresolved-fallback"` to `NO_SAMPLES` (:27-39).
- [ ] **Step 4: README** — add one paragraph: store fixtures, `sample-props.json` carrying `__store` (C1), the harness shim, and that `cart.ts` is not a component.
- [ ] **Step 5:** `cargo test -p brust-compiler --test dual_eval -- --nocapture`. The output names `store-read:1`, `store-derived:1`, `store-handler-write:≥1`; existing fixture counts are unchanged; `total` rises. Commit `test(compiler): store fixtures + dual evaluation seeded from __store (M3-F §2.3)`.

### Task 10: Battery rows

**Files:** `scripts/battery/rows.ts`, `scripts/battery/exit.ts` (`DUAL_EVAL_NO_SAMPLES` += `'store-unresolved-fallback'`), the two generated reports.

- [ ] **Step 1: Rows** in category E. All of them use `const ST = \`import { useStore } from 'brust/store/react'\nimport { cart } from './cart'\n\`` and `files: { 'cart.ts': CART }`, where `CART = \`import { defineStore, signal, computed } from 'brust/store'\nexport const cart = defineStore('cart', () => { const count = signal(0); const dbl = computed(() => count() * 2); return { count, dbl } })\``. Every expectation cites the spec, not the observation:

| id | expect | jobs | snippet core | note |
|---|---|---|---|---|
| `e-store-read` | native | 0 | `const s = useStore(cart); return <p>{s.count}</p>` | `M3-F D7: store-view root → __store.cart.count` |
| `e-store-destructure` | native | 0 | `const { count } = useStore(cart); return <p>{count}</p>` | `M3-F D7` |
| `e-store-derived` | native | 1 | `+ import { fmt } from './fmt'`; `<p>{fmt(s.count)}</p>` | `M3-F D7: precompute slot keyed by __store.cart.count` |
| `e-store-handler-write` | native | 0 | `<button onClick={() => cart.count.set(s.count + 1)}>{s.count}</button>` | `M3-F D7: writes in handlers are plain calls` |
| `e-store-reexport` | native | 0 | handle from `./stores` (`export { cart } from './cart'`) | `M3-F D7: re-exports followed` |
| `e-store-unresolved` | react | — | handle from the package `shop-stores` | fallback `store-name-unresolved` |
| `e-store-write-in-render` | react | — | `const n = cart.count.set(1); return <p>{s.count}</p>` | fallback `store-write-in-render` |
| `e-store-computed-key` | react | — | `<p>{s.dbl}</p>` | R1: fallback `store-key-unsupported` |

- [ ] **Step 2:** `bun run battery` → `[battery] N rows, 0 unexplained ⚠`.
  - `git diff docs/` shows ONLY the eight new rows, the summary counts, and the exit report's dual-eval pin line.
  - `bun test scripts/battery` green (every react row has a fallback and no error).
  - Commit rows + `exit.ts` + both reports: `test(battery): store rows (M3-F D7)`.

### Task 11: Full gates + READY

- [ ] Run every gate in order on a clean tree. Then `git status --short` must be empty, and `git log --oneline m3f..` must show 10 commits. Post READY (template below).

## Review Focus

1. **Job-key correctness.** A derived slot over a store path changes its key when the value changes:
   - `inputs` carry `__store.<name>.<key>` from the read itself, from enclosing `If` guards and from per-item list sources, or the coarse `__store` for dotted names (R3).
   - The key does NOT move for an unrelated store key (fine path).
   - `minimal_paths` never drops a store path except under `__store` or `*` (and `*` for a chain component evaluates the whole ctx, `__store` included).
   - Pinned by Task 5's IR tests and `store_job_keys.rs`.
2. **Fallback never silently renders a wrong value.**
   - Every shape the server cannot paint exactly is refused BEFORE lowering with a golden Fallback, tier React: an unresolved name, a non-signal key, a bare view, a write or a handle read in render (Tasks 1/2/6).
   - No `Server` or `Precomputed` value ever names an unresolved store.
   - The walker obeys the whole-subtree rule (JSX in expressions, call-argument arrows, called local functions, opaque captures).
   - Handlers and effects stay native (negative cases in Task 6).
3. **First paint == client initial value.**
   - The template path `__store.<name>.<key>` and the chunk read `<handle>.<key>()` name the same store (resolved name ↔ imported handle) and the same key.
   - Escaping is `| e` like every slot.
   - `dual_eval` proves it on seeded `__store` for read, derived and handler fixtures.
   - `client_props` / `x-props` never carry `__store`.
4. **Resolution is by symbol, not spelling.**
   - `useStore`, `defineStore`, `signal`, `computed` are matched through import records (aliases work, a same-named import from another package does not).
   - Re-exports are followed with a depth limit and a visited set.
   - `module` is the defining module, root-relative, which is what C3 puts in the manifest (sorted, unique, transitive over `ir.children`).
   - The name charset follows D6.
5. **C5 contract.**
   - Every `Ssr` job's `inputs` contains `__store` after `minimal_paths`.
   - Island jobs carry `props.__store = "__store"` (R2).
   - Fed children that read stores map `__store` (no `UncoveredInput`).
   - Golden churn is exactly the nine fixtures + the pin + six TS assertions; rendered HTML is unchanged (pokedex byte-identical).
6. **One reactivity rule.**
   - Every site that asked "reads state?" now asks `Deps::reactive()` (template ×3, placement ×3, children ×3).
   - A store-only component is Native, never Static; R5's `state_dependent = true` is the only IR reinterpretation.
   - The chunk imports the handle by the user's specifier, and precompute jobs never import a store module (D8).

## Risk ledger

1. **Namespace handles** (`useStore(stores.cart)`). Bun may rewrite `ns.member` into a generated import identifier. Task 1 pins the observed shape; if it cannot be traced the result is `store-name-unresolved` (fail closed, documented in the task note).
2. **Coarse keys for dotted names** (R3). `'pokedex.team'` reads hash the whole snapshot: correct, coarser L2 reuse. A quoted-key `Path` syntax would be a server contract change (lead ruling, later wave).
3. **`__store` in `_props`** (coordination, server lane). This affects whole-props native hosts and React root islands once ctx carries `__store`. It is not this lane's file; relayed in the READY note.
4. **Island SSR receives `__store`** (R2). The worker must strip it before `renderToString`, or a component that spreads props renders a `__store` attribute (hydration mismatch). The server lane owns it; relayed.
5. **Factory shapes.** Only object-literal returns (expression body or final `return {…}` with `const k = signal|computed(…)`) are read. Other shapes refuse render reads (`store-key-unsupported`): conservative, never wrong. Widen later with a row per shape.
6. **Store-sourced lists with a fed child.** `InstanceRecord.loops` gets `None` and `childRecords` throws `instance-list-path` (manifest.ts:200-201). The build fails closed; ledger it if the dogfood hits it.
7. **Handles behind tsconfig aliases or packages.** `store-name-unresolved` for `useStore`. A render read of such a handle is NOT caught by `store-handle-in-render` (its module cannot be resolved), so its job would throw at runtime. Ledger as a known gap.
8. **No real store API during the lane.** `m3f-store-core` is parallel, so dual_eval uses `harness/store.ts`. After merge, the dogfood lane's e2e + Chromium (§5 items 3–4) exercise the real module. A follow-up may switch the shim to `packages/runtime-dom/src/store` (one line in `dual_eval.rs`).
9. **Cross-tree duplicate names.** `store-name-duplicate` fires within one `compile_tree` only; two route trees defining the same name in different modules are not warned (§4 says "in one build"). Ledger it.
10. **Effects over non-signal keys.** These read `<handle>.snapshot()[k]`, which may not be tracked by the effect (snapshot memoisation). Signal and computed keys are tracked (getter or direct call). Document in `docs/store.md` (dogfood lane).

## Dispatch table

Lane tier: complex (implementer: one complex agent end to end; review complex — compiler output contract + cross-lane contracts C3/C5/C6).

| slug-task | tier | role | deps | acceptance (gate commands + READY evidence) |
|---|---|---|---|---|
| `m3f-store-compiler-1` IR + recognition | standard | implementer | lane created; R1–R5 answered | `cargo test -p brust-compiler --test store` (Task 1 cases) green; full `cargo test -p brust-compiler` green, no golden diff; namespace AST shape noted; commit |
| `m3f-store-compiler-2` name resolution | complex | implementer | 1 | 10 resolve + 8 unresolved + factory + duplicate tests green; re-export cycle terminates; no golden diff; commit |
| `m3f-store-compiler-3` server path | complex | implementer | 2 | jinja `__store.cart.count` / `__store["pokedex.team"]`, render `>3<`, no `x-props`, `client_props` without `__store`; no golden diff; commit |
| `m3f-store-compiler-4` client chunk | complex | implementer | 3 | `cart.count()`, handle import, view object only for verbatim captures, snapshot form for non-signal keys, Native tier; `Deps::reactive` at the 9 sites; no golden diff; commit |
| `m3f-store-compiler-5` derived slots | complex | implementer | 4 | inputs `["__store.cart.count","unit"]`, guard/list/coarse cases, job text, client `computed`; `cargo test -p brust-server --test store_job_keys` green; commit |
| `m3f-store-compiler-6` render checks | complex | implementer | 5 | 7 refused + 5 kept-native cases; whole-subtree walker; no golden diff; commit |
| `m3f-store-compiler-7` manifest stores | standard | implementer | 2 | `build-manifest-stores.test.ts` green; pin diff = `"stores": []` only; TS gates; commit |
| `m3f-store-compiler-8` C5 | standard | implementer | 7 | golden diff = 9 fixtures + pin + 6 TS assertions exactly; e2e + pokedex green; commit |
| `m3f-store-compiler-9` fixtures + dual_eval | complex | implementer | 6, 8 | 4 fixtures with reviewed goldens; dual_eval names the 3 store fixtures with ≥1 check each; NO_SAMPLES pinned; commit |
| `m3f-store-compiler-10` battery | routine | implementer | 9 | 8 rows, `0 unexplained ⚠`, reports regenerated and committed, `bun test scripts/battery` green; commit |
| `m3f-store-compiler-11` gates + READY | routine | implementer | 10 | all gates green on a clean tree; READY note posted |

## File structure

```
crates/brust-compiler/src/ir/expr.rs           IdentKind::Store { handle, key }; default client print; is_js_ident pub(crate)
crates/brust-compiler/src/ir/decls.rs          StoreUse, StoreRef
crates/brust-compiler/src/ir/mod.rs            ComponentIR.stores (skip if empty)
crates/brust-compiler/src/analyze/names.rs     stores map, mark_store, store_view, kind_of arm; module_imports(ast) factored out
crates/brust-compiler/src/analyze/hooks.rs     USE_STORE_SOURCES, is_use_store, store_handle, read_use_store, mark_state_bindings marks stores
crates/brust-compiler/src/analyze/expr.rs      s.count / s["count"] / s?.count → Ident{Store{key}}
crates/brust-compiler/src/analyze/stores.rs    NEW: STORE_API_SOURCES, read_store_export (re-exports, factory keys)
crates/brust-compiler/src/analyze/modules.rs   ModuleCache.store_exports, store_names
crates/brust-compiler/src/analyze/passes/stores.rs  NEW: resolve (first in run_passes), check_render (R1 rules)
crates/brust-compiler/src/analyze/passes/{deps,placement,children,tier,server_expr,mod}.rs   Deps.stores/reactive/split_inputs/store_input; slot inputs; C5
crates/brust-compiler/src/lower/{common,client,template}.rs   store_jinja/store_server_js, client_ident/wrap_source arms, imports, view object, names()
crates/brust-compiler/tests/store.rs           NEW: Tasks 1–6, 8 unit tests
crates/brust-compiler/tests/harness/store.ts   NEW: dual-eval store shim; eval.ts seeds __BRUST_DUAL_STORE__
crates/brust-server/tests/store_job_keys.rs    NEW: projection/job_key over __store paths (no src change)
tests/fixtures/store-{read,derived,handler-write,unresolved-fallback}/   NEW fixtures + goldens
packages/brust/src/build/{manifest,compile}.ts storesOf, ComponentRecord.stores, IR type
scripts/battery/{rows,exit}.ts + docs/react-coverage.md + docs/plans/m1-exit-report.md (generated)
```

## READY note template

```
READY lane/m3f-store-compiler @ <sha> (base m3f @ <sha>)
rulings applied: R1 <accepted/…> R2 <…> R3 <…> R4 <…> R5 <…>
D7 surface: useStore recognised from <sources>; view + destructure; namespace handle = <traced | store-name-unresolved (AST shape: …)>
resolution: direct/default/clause/from/star/import-then-export ✓; unresolved reasons pinned (8); duplicate warning in-tree
server path: {{ __store.cart.count | e }}; dotted → __store["pokedex.team"]; job inputs fine/coarse per R3
client: cart.count(); handle imported by user specifier; view object only for verbatim captures; Native for store-only components
derived: inputs ["__store.cart.count","unit"]; state_dependent=true (R5); store_job_keys.rs: value change → key change, unrelated key → same
render checks: write/handle/key-unsupported refused (7 cases), handlers/effects/props native (5 cases)
C3: storesOf transitive, sorted, unique; pin diff "stores": [] only
C5: ssr inputs ["*","__store"]; island props.__store; fed children map __store; golden churn = 9 fixtures + pin + 6 TS asserts
dual_eval: store-read:<n> store-derived:<n> store-handler-write:<n>; total <before> → <after>
battery: <N> rows (+8), 0 ⚠; reports regenerated
gates: <paste fmt / clippy / cargo test / battery+diff / bun test scripts/battery / browser-test / brust-server tests / packages/brust / pokedex>
relay to m3f-store-server: (1) strip inputs.__store before island renderToString (R2); (2) __store must stay in all_props (C5) if hidden from _props (x-props of whole-props hosts / React roots)
ledger candidates: store-sourced list + fed child (instance-list-path), alias/package handles not caught in render, cross-tree duplicate names, effects over non-signal keys
```
