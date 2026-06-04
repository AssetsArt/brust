# Native `x-props` auto-serialize (`| tojson`) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (one subagent per task, strict sequence). Steps use checkbox (`- [ ]`).

**Goal:** native `x-props` auto-serializes a structured `{expr}` value to JSON in-template (`| tojson | e`), so loaders stop pre-`JSON.stringify`-ing. Migrate the 2 pokedex x-props usages; drop the redundant `dexProps`.

**Spec:** `docs/superpowers/specs/2026-06-04-native-xprops-tojson-design.md` (READ IT — breaking change for string-passing x-props; spec-review fixes applied).

**Base commit:** `187b456` (branch `feat/native-xprops-tojson`, off `main` = released 0.1.30-alpha).

**Tech Stack:** Rust (compiler emit + minijinja `json` feature), TS/Bun example, biome.

---

## Conventions (repo rules)
- Rust gates: `cargo fmt --all --check` · `cargo clippy --workspace --all-targets --locked -D warnings` · `cargo test --workspace --locked`.
- **napi rebuild after ANY Rust edit:** `cd runtime && bun run build` (stale `.node` serves old output).
- TS gates: `bun run ci` (biome) · `bun run typecheck:treaty` · `bun test runtime/` (baseline **472**).
- Never `git add -A`. Pokedex: `bun run runtime/cli/index.ts build example/pokedex/index.ts`.

---

## Load-bearing facts (verified)
- `emit_attr` `other =>` arm (`emit_jinja.rs:408`): `out.push(' '); out.push_str(&a.name); out.push_str("=\""); emit_escaped_interp(out, other); out.push('"');`. `a.name` is in scope → branch on `a.name == "x-props"`.
- `emit_escaped_interp` (`emit_jinja.rs:238`): `write!(out, "{{{{ ({}) | e }}}}", emit_expr_path(e))`. The tojson variant: `{{ ({path}) | tojson | e }}`.
- `Static`/`Empty`/`StaticText`/`StaticNum` x-props take OTHER arms (untouched) — only the `Expr::other` runtime path serializes.
- minijinja `tojson` is OFF (verified `UnknownFilter`). Enable `features = ["json"]`: `crates/brust/Cargo.toml` (`[dependencies]`) + `crates/jsx-rust-compiler/Cargo.toml` (**`[dev-dependencies]`** — golden-render test bin). Auto-registers `tojson` (no `add_filter`).
- `lower_attr` passes `x-props={items}` as `AttrValue::Expr(Field("items"))` — NO lower.rs/IR change.
- Render harness `golden_render_jinja/main.rs`: `render_fixture(name, ctx)` compiles `fixtures/{name}.tsx` + renders via its own `Environment::new()` (needs the json feature) + `check_golden`. Pattern: `renders_list_nav_byte_equal` (passes a `vec!` of structs in `context!`).
- 2 x-props usages: `DexFilter.tsx:55` `x-props={data}`, `AddToTeamButton.tsx:90` `x-props={data}`. NavLink does NOT use x-props. 3 `JSON.stringify` sites: `loaders.ts:95` (dexProps), `:187` + `:220` (addProps).

---

## File Structure
```
crates/brust/Cargo.toml                              # minijinja features=["json"]              (edit)
crates/jsx-rust-compiler/Cargo.toml                  # minijinja (dev-dep) features=["json"]    (edit)
crates/jsx-rust-compiler/src/emit_jinja.rs           # x-props → | tojson | e branch            (edit)
crates/jsx-rust-compiler/tests/golden_emit_jinja.rs  # + xprops_tojson fixture                  (edit)
crates/jsx-rust-compiler/tests/golden_render_jinja/main.rs  # + render test for xprops_tojson   (edit)
crates/jsx-rust-compiler/fixtures/xprops_tojson.{tsx,expected.jinja}                            (new)
crates/jsx-rust-compiler/tests/golden_render_jinja/<expected>/xprops_tojson...                 (new, via UPDATE_GOLDEN)
example/pokedex/components/DexFilter.tsx             # x-props={items}, behavior props-as-array (edit)
example/pokedex/components/AddToTeamButton.tsx       # data prop type string→object            (edit)
example/pokedex/pages/BrowsePage.tsx                 # <DexFilter items={items}/> (drop data)   (edit)
example/pokedex/lib/loaders.ts                       # drop dexProps + JSON.stringify×3         (edit)
example/pokedex/lib/types.ts                         # BrowseData drop dexProps; DetailData addProps object (edit)
```

---

## Spec → Task coverage
| Spec section | Task |
|---|---|
| §1 minijinja json feature | Task 1 |
| §2 compiler x-props \| tojson emit | Task 1 |
| Tests: emit golden + render golden + non-x-props regression | Task 1 |
| §3 example migration (DexFilter/AddToTeamButton/loaders/types/BrowsePage) | Task 2 |
| Acceptance 4-5: curl + browser | Task 2 + Phase 6 |

---

## Task 1 — Rust: minijinja `json` + `x-props` emits `| tojson | e` (+ goldens)

**Files:** `crates/brust/Cargo.toml`, `crates/jsx-rust-compiler/Cargo.toml`, `emit_jinja.rs`, `golden_emit_jinja.rs`, `golden_render_jinja/main.rs`, 2 fixture files.

- [ ] **Step 1: Enable the json feature.**
  - `crates/brust/Cargo.toml`: `minijinja = "2"` → `minijinja = { version = "2", features = ["json"] }` (in `[dependencies]`).
  - `crates/jsx-rust-compiler/Cargo.toml`: same change in **`[dev-dependencies]`**.

- [ ] **Step 2: Write failing goldens FIRST.**

`fixtures/xprops_tojson.tsx`:
```tsx
export default function Widget({ items }: { items: { id: number; label: string }[] }) {
  return (
    <section x-data="w" x-props={items}>
      <a href={items}>x</a>
    </section>
  )
}
```
> The `<a href={items}>` is a deliberate NON-x-props attr with the SAME expr — proves the special-case is scoped to `x-props` (href stays `| e`, x-props becomes `| tojson | e`). (`href={items}` is nonsensical semantically but exercises the emit path; if `lower_attr` rejects an array in `href`, swap to `href={items}` → use a scalar prop like `id`: `<a href={id}>` with `id` added to the destructure. Pick whatever lowers; the POINT is one x-props + one non-x-props attr sharing the emit path.)

Add `"xprops_tojson"` to `FIXTURES` in `golden_emit_jinja.rs`. Create an empty `.expected.jinja`, run the emit golden, CAPTURE real output. Target (freeze from REAL emit — x-props gets tojson, href stays plain):
```jinja
<section x-data="w" x-props="{{ (items) | tojson | e }}"><a href="{{ (items) | e }}">x</a></section>
```
Run the emit golden → it FAILS (no tojson yet). Confirms the baseline.

- [ ] **Step 3: Implement the emit branch** in `emit_jinja.rs` `other =>` arm:
```rust
            other => {
                out.push(' ');
                out.push_str(&a.name);
                out.push_str("=\"");
                if a.name == "x-props" {
                    // x-props carries a STRUCTURED value: serialize to JSON in-template
                    // (then HTML-escape, same XSS model as `| e`). Lets loaders pass a
                    // real array/object instead of a pre-JSON.stringify'd string.
                    let _ = write!(out, "{{{{ ({}) | tojson | e }}}}", emit_expr_path(other));
                } else {
                    emit_escaped_interp(out, other);
                }
                out.push('"');
            }
```
(Keep the existing doc comment above the arm; `write!` + `emit_expr_path` are already imported/used in this file.)

- [ ] **Step 4: Freeze the emit golden** from real output; confirm it matches the target shape.

- [ ] **Step 5: Render golden** — add a render test in `golden_render_jinja/main.rs` mirroring `renders_list_nav_byte_equal`:
```rust
#[test]
fn renders_xprops_tojson_byte_equal() {
    let actual = render_fixture(
        "xprops_tojson",
        context! { items => vec![context!{ id => 1, label => "a" }, context!{ id => 2, label => "b" }] },
    );
    check_golden("xprops_tojson", &actual);
}
```
Generate the render expected with `UPDATE_GOLDEN=1 cargo test -p jsx-rust-compiler --test golden_render_jinja renders_xprops_tojson 2>&1`. INSPECT the generated expected: the `x-props` attr must contain the HTML-escaped JSON array (e.g. `x-props="[{&quot;id&quot;:1,&quot;label&quot;:&quot;a&quot;},…]"`), NOT `[object Object]` or an error. This proves `tojson` is wired + the json feature is on. Freeze it.
> If `render_fixture`'s expected files live in a specific dir, `UPDATE_GOLDEN` writes them there — let it; then commit the new expected file.

- [ ] **Step 6: Gates** — `cargo test --workspace --locked` (emit + render goldens green) · `cargo fmt --all --check` · `cargo clippy --workspace --all-targets --locked -D warnings`.

- [ ] **Step 7: REBUILD NAPI** — `cd runtime && bun run build`; then `bun test runtime/` (baseline 472 — no runtime change, proves the addon rebuilt clean).

**BLOCKED fallback:** if `lower_attr` rejects an array literal/array-typed expr in the `href={items}` regression position, use a scalar prop for the non-x-props attr (`<a href={label}>` with a string prop) — the regression only needs ONE non-x-props attr emitting plain `| e` alongside the x-props one.

**Commit:** `feat(compiler): native x-props serializes structured values via | tojson (minijinja json feature)`

---

## Task 2 — Example migration (pokedex): structured x-props, drop the stringify hack

**Files:** `DexFilter.tsx`, `AddToTeamButton.tsx`, `BrowsePage.tsx`, `lib/loaders.ts`, `lib/types.ts`.

- [ ] **Step 1: DexFilter** (`components/DexFilter.tsx`):
  - Signature: `export default function DexFilter({ items }: { items: Card[] })` (drop `data`).
  - `<section x-data="dexFilter" x-props={items}>` (was `x-props={data}`).
  - Behavior: `const all = ((props as Card[]) ?? []) as Card[]` (was `(props as { items?: Card[] })?.items ?? []`). Everything else (`items` signal, `apply`, search/sort) UNCHANGED — it already operates on `all` + the `items` signal.
  - The grid `{items.map((c) => <a x-for key={c.id} …>)}` UNCHANGED (already uses the `items` prop).

- [ ] **Step 2: BrowsePage** (`pages/BrowsePage.tsx`): `<DexFilter native items={items} />` (drop `data={dexProps}`). Update the destructure to `{ items }` (drop `dexProps`).

- [ ] **Step 3: browseLoader** (`lib/loaders.ts`): return `{ ...chrome(...), items }` (drop `dexProps: JSON.stringify({ items })`).

- [ ] **Step 4: AddToTeamButton** (`components/AddToTeamButton.tsx`): the `x-props={data}` JSX is UNCHANGED; change the component's `data` prop TYPE from `string` to the object shape (mirror the `addProps` object: `{ id, name, displayName, num, types, artwork }`). The behavior (`props.id` etc.) is UNCHANGED. Drop the "precomputed string" comment.

- [ ] **Step 5: detailLoader + emptyDetail** (`lib/loaders.ts`, 2 sites): `addProps: { id, name, … }` (drop `JSON.stringify(...)` + the "can't JSON.stringify" comment). Same keys.

- [ ] **Step 6: types** (`lib/types.ts`): `BrowseData` — drop `dexProps: string` (keep `items: DexCard[]`). `DetailData` — `addProps` type `string` → the object shape (a named interface or inline `{ id: number; name: string; displayName: string; num: string; types: …; artwork: string }` matching the loader). Make the AddToTeamButton component's `data` prop type reference the same shape.

- [ ] **Step 7: Build + curl proof.**
  - `bun run runtime/cli/index.ts build example/pokedex/index.ts` (must succeed).
  - `grep -o 'x-props="[^"]*"' .brust/jinja/BrowsePage.jinja` → the dex section's `x-props` must be the HTML-escaped JSON **array** (`[{&quot;id&quot;…`), NOT `data` reference / `[object Object]`. Capture it.
  - Boot dev + `curl -s localhost:39xxx/pokedex` → `grep -c 'data-x-key=' ` = 151 (cards still SSR); `grep -o 'x-props="\[' ` present (serialized array in the live HTML). Kill port.
  - `grep -rn "JSON.stringify\|dexProps" example/pokedex/lib/loaders.ts` → must be EMPTY (hack gone).

- [ ] **Step 8: Gates** — `bun run ci` (biome) · `bun run typecheck:treaty` (0 — catches the AddToTeamButton/DexFilter prop type changes).

**BLOCKED fallback:** if `typecheck:treaty` flags a residual `string` assumption (e.g. `data` passed somewhere expecting string), fix the type at the declaration — do NOT cast. The whole point is the structured value flows typed.

**Commit:** `feat(example): pokedex passes structured x-props (drop dexProps + JSON.stringify hack)`

---

## Phase 6 — Scrutinize + verify (orchestrator; NO release)
Re-run baselines myself: cargo fmt/clippy/test + goldens · napi rebuild · biome · typecheck:treaty 0 · `bun test runtime/` 472 · native integration (`native-island native-island-ssr native-inline native-source-mode cli-build integration`, ports killed). Trace the emit branch on the real diff. Browser: `/pokedex` search filters (DexFilter parsed the serialized array) + a detail page AddToTeam toggle (AddToTeamButton parsed the serialized object). Confirm no `JSON.stringify`/`dexProps` in loaders. **NO RELEASE.**

**Acceptance** (spec §): cargo green + emit/render/regression goldens + napi · biome+treaty+472 · integration green · curl x-props = escaped JSON array + 151 cards + loaders hack-free · browser DexFilter + AddToTeam work · non-x-props attr stays `| e` (golden).

## Known risks
- **json feature in the wrong Cargo section** (jsx-rust-compiler = dev-dep) — Task 1 Step 1.
- **`| e` parity with islands `entityEncode`** — verified identical charset; render golden proves round-trip.
- **typecheck residual string assumptions** — Task 2 Step 8 catches; fix at declaration.
- **napi staleness** — rebuild after Task 1.
