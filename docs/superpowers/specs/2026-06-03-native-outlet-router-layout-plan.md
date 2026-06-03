# Plan: native `<Outlet>` / router-level layout (approach a, build-time desugar)

Spec: `2026-06-03-native-outlet-router-layout-design.md`. Branch `feat/native-outlet-router-layout`.
Baseline (parent `679816c`): compiler `cargo test -p jsx-rust-compiler` → **249 pass** (238 lib + 11);
runtime `cd runtime && bun test` → **360 pass / 0 fail**.

Gates: `bun run ci` (biome, ROOT) · `cargo fmt --all --check` · `cargo clippy --workspace --all-targets --locked -- -D warnings` · `cargo test --workspace` · `cd runtime && bun test`.
**After ANY Rust edit:** `cd runtime && bun run build:debug` (rebuild napi) before bun integration tests. Native render tests: run files SEPARATELY; kill stale port first.

## Spec coverage map
| Spec section | Task |
|---|---|
| Reproduce-first probe | T0 (DONE) |
| Compiler `<Outlet/>`→ChildrenSlot (§3, F4) | T1 |
| Lift ban + synth wrapper + chain sources (§1,§2, B1/F1/F2) | T2 |
| Chain loader merge render+nav (Loader semantics, F3) | T3 |
| Integration render test | T4 |
| Dogfood pokedex + chrome migration (§dogfood, F5) | T5 |

---

## T0 — reproduce-first probe — ✅ DONE
Confirmed (spec "Reproduce-first probe — DONE"): synth wrapper `<AppLayout native><Leaf native/></AppLayout>`
+ component_sources → composed native Document via `{children}` (2-level + 3-level), 0 React. `<Outlet/>`
today = SsrComponent → needs builtin. No code committed (probe reverted).

---

## T1 — compiler: `<Outlet/>` → `ChildrenSlot` builtin (Rust, TDD)

**Files:** `crates/jsx-rust-compiler/src/lower.rs`, `.../src/lib.rs` (golden tests), maybe `.../src/error.rs` (new `OutletMustBeEmpty` ErrorKind).

### Step 1a — RED: golden tests in `lib.rs` (mirror existing `sources.insert` pattern ~`:1549`)
```rust
#[test]
fn outlet_lowers_to_children_slot() {
    // layout uses <Outlet/>; synth wrapper inlines it with a native child → content in slot
    let route = r#"export default function Chain() { return <AppLayout native><Leaf native/></AppLayout>; }"#;
    let layout = r#"import { BrustPage } from 'brustjs'
export default function AppLayout() { return <BrustPage title="x"><main class="c"><Outlet/></main></BrustPage>; }"#;
    let leaf = r#"export default function Leaf() { return <section>leaf</section>; }"#;
    let mut s = std::collections::HashMap::new();
    s.insert("AppLayout".into(), layout.into());
    s.insert("Leaf".into(), leaf.into());
    let c = compile_full(route, "<t>", s).unwrap();
    assert!(c.template.contains(r#"<main class="c"><section>leaf</section></main>"#), "got: {}", c.template);
    assert!(!c.template.contains("comp_0_html"), "Outlet must NOT become an SSR component");
}

#[test]
fn outlet_must_be_empty() {
    let layout = r#"export default function L() { return <div><Outlet>x</Outlet></div>; }"#;
    // compile L as a standalone native root via a wrapper that inlines it
    let route = r#"export default function C() { return <L native/>; }"#;
    let mut s = std::collections::HashMap::new();
    s.insert("L".into(), layout.into());
    let err = compile_full(route, "<t>", s).unwrap_err();
    assert!(matches!(err.kind, ErrorKind::OutletMustBeEmpty), "got {:?}", err.kind);
}

#[test]
fn children_composition_still_works() {
    // regression: shipped PageLayout {children} path unchanged
    let route = r#"export default function Chain() { return <Lay native><Leaf native/></Lay>; }"#;
    let lay = r#"import { BrustPage } from 'brustjs'
export default function Lay({ children }) { return <BrustPage title="x"><main>{children}</main></BrustPage>; }"#;
    let leaf = r#"export default function Leaf() { return <p>hi</p>; }"#;
    let mut s = std::collections::HashMap::new();
    s.insert("Lay".into(), lay.into()); s.insert("Leaf".into(), leaf.into());
    let c = compile_full(route, "<t>", s).unwrap();
    assert!(c.template.contains("<main><p>hi</p></main>"), "got: {}", c.template);
}
```
Run `cargo test -p jsx-rust-compiler outlet` → fail (Outlet still SsrComponent; OutletMustBeEmpty missing).

### Step 1b — GREEN: `lower.rs`
- Find where `<BrustPage>`/`<Island>` builtins are recognized in `lower_element` (the capitalized-tag branch ~`:585-593` that otherwise makes SsrComponent). Add a `"Outlet"` case BEFORE the SsrComponent fall:
  - if the element has any children or any attrs → `return Err(CompileError { kind: ErrorKind::OutletMustBeEmpty, .. })` (mirror how `BrustPageMustBeRoot`/existing errors are constructed, incl. span).
  - else → `Ok(JsxNode::ChildrenSlot)` unconditionally (NOT gated on `scope.inline`).
- Add `OutletMustBeEmpty` to `ErrorKind` (`error.rs`) with a `#[error("...")]` message matching the existing style.
Run `cargo test -p jsx-rust-compiler outlet` → 3 pass. Then full `cargo test -p jsx-rust-compiler` → 249+3.

### Step 1c — gates + napi
- `cargo fmt --all` · `cargo clippy --workspace --all-targets --locked -- -D warnings`
- `cd runtime && bun run build:debug` (rebuild napi — compiler changed)
Commit: `feat(compiler): <Outlet/> builtin lowers to ChildrenSlot`.

**BLOCKED fallback:** if `<Outlet/>` recognition collides with how SsrComponent collection indexes components (comp_N numbering), check `collect_components`/emit_factory — Outlet must be removed from the SSR component list entirely. If the builtin branch is hard to place, fall back to recognizing `Outlet` ident in the same spot `BrustPage` is matched and short-circuit.

---

## T2 — lift ban + synth wrapper + chain sources (TS, TDD)

**Files:** `runtime/routes.ts` (`validateRoute`), `runtime/cli/native-routes-emit.ts`, type widenings (`build.ts`, `dev.ts`).

### Step 2a — RED: tests
- `runtime/routes.test.ts` (or the file holding validateRoute tests): native parent + native children → OK; native parent + non-native child (or reverse) → throws clear error.
- `runtime/cli/native-routes-emit.test.ts` (create or extend): given a flat native leaf with `chain=[AppLayout, Leaf]`, the synth wrapper source equals `export default function ...() { return <AppLayout native><Leaf native/></AppLayout>; }` (assert the generated string shape + that ALL levels carry `native`), and the gathered sources map includes BOTH `AppLayout` and `Leaf` keys.

### Step 2b — GREEN
- `validateRoute` (`routes.ts:336-338`): allow `native:true` with `children` **iff every node in the subtree is native**; reject mixed with a clear `Error("native route chain cannot mix native and non-native components")`.
- `emitNativeTemplates` (`native-routes-emit.ts:313`): for a native leaf whose `chain.length > 1`, build the synth wrapper source (nest parent→leaf, EVERY tag gets `native`, `export default function`). Feed it to `compile_full` as the route source under the leaf's template name.
- **B1:** union `gatherComponentSources()` over EVERY chain component's resolved source path (resolve each component name via the `routes.tsx` import map from `scanImports(entryFile)` ~`:342`), plus the leaf's own. Merge into one sources map for the compile call.
- **F2:** widen `flatRoutes` element type to include `chain` in `native-routes-emit.ts:137`, `build.ts:331`, `dev.ts:85`.
- `chain.length===1` → existing path unchanged.

### Step 2c — gates
- `bun run ci`; `cd runtime && bun test native-routes-emit.test.ts routes.test.ts`
Commit: `feat(routes): native nested routes — lift ban, synth wrapper, gather chain sources`.

**BLOCKED fallback:** if `chain` is not actually populated on the objects reaching `emitNativeTemplates` (only `nativeTemplate` is), trace `flattenRoutes`→ how flatRoutes flows to emit; the `chain` may need to be threaded from `defineRoutes` output. Confirm with a console probe before assuming.

---

## T3 — chain loader merge: render + nav (TS, TDD)

**Files:** `runtime/routes.ts` (`makeRenderer` native branch ~`:635-752`; `renderNativeRouteToHtml` ~`:1026-1081`).

### Step 3a — RED: tests
- unit: a helper `runChainLoaders(chain, ctx)` (extract if needed) — top-down order, shallow-merge child-wins, first `notFound()/redirect()` short-circuits (later loaders not called), all within ONE `runInStoreContext`.
- assert chain.length===1 → identical to today (leaf data only).

### Step 3b — GREEN
- Replace the leaf-only loader call (`:637`, `:1034`) with a loop over `flat.chain` top-down: run each loader, check verdict (short-circuit), else accumulate `merged = {...merged, ...result}`. Wrap the WHOLE loop in ONE `runInStoreContext` (F3 — match React chain path `:759`,`:1106`).
- Write `merged` JSON to SAB as today. Template name still leaf's.
- Nav path mirrors: same merge before `napiRenderJinja`.

### Step 3c — gates + napi already built (no Rust change here)
- `cd runtime && bun test routes.test.ts` + run the native render test files separately.
Commit: `feat(routes): merge native chain loaders top-down (child-wins, single store ctx)`.

**BLOCKED fallback:** if `runInStoreContext` signature doesn't allow wrapping an async loop cleanly, mirror EXACTLY how React chain (`buildRenderElement` ~`:1106`) wraps its loader loop. Don't invent a new pattern.

---

## T4 — integration render test (TS)

**Files:** `runtime/tests/jinja-route.test.ts` (+ fixture under `tests/fixtures/app/`).

- Add a nested native fixture: a layout (`<BrustPage><nav/><main><Outlet/></main></BrustPage>`) + a leaf fragment, wired as a nested route. Route `/_test/outlet`.
- Test: GET renders composed HTML → contains shell (`<html>`,`<nav>`) AND leaf content inside `<main>`, exactly one `<main>`, one `<title>`.
- If feasible, a nav test (`/_brust/page/...`) returns `{html,title}`.
Run separately; kill stale port. Build fixtures first (`bun run runtime/cli/index.ts build` on the test app if the harness needs it — check how jinja-route.test.ts boots).
Commit: `test(routes): nested native route renders composed document`.

---

## T5 — dogfood pokedex (chrome migration, F5)

**Files:** `example/pokedex/routes.tsx`, `components/PageLayout.tsx` → rename/repurpose to `AppLayout.tsx` (layout, no props, uses `<Outlet/>`), `lib/loaders.ts` (each leaf loader returns `title/active/crumb/teamProps`), the 3 page components (drop the `<PageLayout native ...>` wrapper → bare fragment), `lib/types.ts` if needed.

- `routes.tsx`: nest under one native `AppLayout` parent with 3 native children (`/`, `/pokemon/{name}`, `/type-chart` or current paths).
- `AppLayout`: the shipped PageLayout body, but **propless** — reads `data.active`/`data.crumb`/title via merged loader context (member-path + S11 conditional), `<main className="aa-content"><Outlet/></main>`, `<TeamBuilder props={data.teamProps}/>`.
- Each leaf loader merges in `{ title, active, crumb, teamProps }` alongside its page data.
- Each page component: return just the inner content fragment (no BrustPage/PageLayout).
- **convention:** only AppLayout has `<main>`; leaves must not.

### Verify (AC)
- `bun run ci`; `cargo fmt --check`; `cargo clippy ...`; `cargo test --workspace`; `cd runtime && bun test` (360+new, no regress).
- `cd runtime && bun run build:debug` (napi current).
- Build pokedex: `bun run runtime/cli/index.ts build example/pokedex/index.ts` → success.
- Boot + smoke (chrome-devtools or curl): `BRUST_PORT=1337 bun run runtime/cli/index.ts dev example/pokedex/index.ts` → `/`, `/pokemon/charizard`, type-chart render with shell+content; SPA-nav no full-reload; active-nav highlight correct; team-dock island works. Kill stale `lsof -ti:1337 | xargs kill -9`.
Commit: `feat(pokedex): dogfood native <Outlet> — single AppLayout, router-level nesting`.

---

## Final verification (Phase 6, orchestrator re-runs)
1. `cargo test --workspace` + `cargo clippy --workspace --all-targets --locked -- -D warnings` + `cargo fmt --all --check` — all green (re-run myself).
2. `cd runtime && bun run build:debug` then `cd runtime && bun test` → 360 + new, 0 fail.
3. `bun run ci` clean.
4. pokedex build + live smoke (view-source shell+content, SPA-nav, active-nav, team island).
5. Read the diff of `lower.rs` + `routes.ts` loader-merge + `native-routes-emit.ts` synth myself.

## Open risks carried into impl
- **B1** (chain source gathering) is the highest-risk integration point — verify the gathered map actually contains the layout source by a console probe in T2 before trusting the build.
- Layout `<main>` vs leaf `<main>` collision (Q1) — dogfood must keep `<main>` only in AppLayout.
- Loader key collisions (Q3) — pick non-colliding names in dogfood loaders.
