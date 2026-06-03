# Native nested `.map()` — verify, lock-in, dogfood

**Date:** 2026-06-03 · **Status:** design (auto-pipeline) · **Repo:** brust
**FRAMEWORK-GAP:** "nested `.map()` บน native ไม่มี fixture ยืนยัน · เลี่ยงไว้ก่อน"
(`example/pokedex/FRAMEWORK-GAPS.md`)

## Goal

Confirm, lock in with regression tests, and dogfood the fact that **nested
`.map()` already works on the native (`native: true`) compile path**. The
PokéDex type-chart currently flattens its 19×19 grid into a single row-major
array to use ONE `.map()`; this spec removes that workaround and proves the
nested form end-to-end.

## Finding (reproduced, NOT a hypothesis)

`jsx-rustc` already lowers and emits nested `.map()` correctly. Built
`target/debug/jsx-rustc` and compiled 5 fixtures by hand — every one produced
correct nested `{% for %}` jinja:

| Variant | Input shape | Emitted jinja (exact) |
|---|---|---|
| Member source | `rows.map(r => <tr>{r.cells.map(c => <td>{c.label}</td>)}</tr>)` | `<table>{% for r in rows %}<tr>{% for c in r.cells %}<td>{{ (c.label) \| e }}</td>{% endfor %}</tr>{% endfor %}</table>` |
| Outer-binding ref in inner | inner body uses `r.type` and `c.label` | `…<td>{{ (r.type) \| e }}:{{ (c.label) \| e }}</td>…` |
| 3-level | `groups → g.rows → r.items` | `<div>{% for g in groups %}<section>{% for r in g.rows %}<ul>{% for i in r.items %}<li>{{ (i.name) \| e }}</li>{% endfor %}</ul>{% endfor %}</section>{% endfor %}</div>` |
| Map binding directly | `matrix.map(row => row.map(cell => …))` (row is an array) | `<table>{% for row in matrix %}<tr>{% for cell in row %}<td>{{ (cell.v) \| e }}</td>{% endfor %}</tr>{% endfor %}</table>` |
| Nested + per-item cond | inner `c.hot ? <td class="hot"> : <td>` | `…{% for c in r.cells %}{% if c.hot %}<td class="hot">{{ (c.v) \| e }}</td>{% else %}<td>{{ (c.v) \| e }}</td>{% endif %}{% endfor %}…` |

**Mechanism (why it already works):** `lower_child` (lower.rs:2458) recognises
a `.map()` CallExpr child and recurses into `lower_call_as_map`, which clones
the scope and pushes the new iter binding onto `scope.map_bindings`. A nested
map child therefore re-enters the same path with the outer binding still in
scope. `lower_map_body_expr` accepts an element whose children include another
`.map()` expression container. The "leave inference alone" comment
(lower.rs:3571) for nested-map sources only affects the compiler's **internal**
`PropsShape` tracking — and `Compiled` does **not** emit prop types / `.d.ts` at
all (TS types come from the loader's own return type), so output correctness is
unaffected.

This gap is therefore **verification + lock-in + dogfood**, NOT a compiler
change. No edits to `lower.rs` / `emit_jinja.rs` lowering logic.

## Non-goals

- **No lowering/emit logic changes.** If a golden test reveals a real defect,
  STOP and escalate — that would change scope from "verify" to "fix".
- Keyed `x-for`-style diff, `(item, idx)` two-arg map (still
  `MapIndexParamNotSupported`), bare-fragment map body — all remain rejected
  as before (out of scope, unchanged).
- No visual redesign of the type chart — output must stay pixel-identical.

## Part 1 — Compiler golden tests (`crates/jsx-rust-compiler/src/lib.rs`)

Add `#[test]` cases in the `lib.rs` test module using the existing
`compile(src) -> Result<String, CompileError>` API (returns the jinja template
string). Assert with `assert_eq!` against the **byte-exact** strings from the
Finding table (not `.contains()`), so any lowering regression flips the test.

Tests to add (one per variant):
1. `native_nested_map_member_source`
2. `native_nested_map_inner_refs_outer_binding`
3. `native_nested_map_three_levels`
4. `native_nested_map_binding_is_array`
5. `native_nested_map_with_per_item_conditional`

Each wraps the body in `export default function P({ ... }) { return <…>; }` and
asserts the full emitted template equals the expected jinja.

## Part 2 — Runtime render test (`tests/fixtures/app` + `tests/jinja-route.test.ts`)

Prove the nested `{% for %}` renders through brust's real pipeline (loader →
SAB → minijinja → `[meta_len][meta][body]`), not just the compiler.

- **New fixture page** `tests/fixtures/app/pages/NativeNestedMap.tsx`: a
  `native: true` page that maps `rows.map(r => <div class="row">{r.cells.map(c
  => <span class="cell">{c.label}</span>)}</div>)`.
- **Route** in `tests/fixtures/app/routes.tsx`: `native: true`, `Component:
  NativeNestedMap`, path `/_test/nested-map`, with an inline loader returning
  nested data, e.g. `{ rows: [{ id:'r0', cells:[{label:'a'},{label:'b'}] },
  { id:'r1', cells:[{label:'c'}] }] }`.
- **Assertions** appended to `tests/jinja-route.test.ts` (reuses the existing
  port-3801 boot of `fixtures/app` — no new test file, avoids a second
  server-boot/port-race): `GET /_test/nested-map` → 200, body contains the
  rendered nested structure (`<div class="row">` ×2, `<span class="cell">a`,
  `b`, `c` in order).

The fixture's data is **static in the loader** (no external fetch) to keep the
test hermetic.

## Part 3 — PokéDex dogfood (remove the flatten workaround)

Restructure the type chart from a flat 361-cell array to nested rows, rendered
with a nested `.map()`. Keep the visual **pixel-identical** via
`display: contents` on the row wrapper, so the existing
`.dex-tc { display: grid; grid-template-columns: 58px repeat(18, …) }` still
lays out every cell as a direct grid item.

- **`example/pokedex/lib/types.ts`**: add
  `TypeChartRowVM { id: string; cells: TypeChartCellVM[] }`; change
  `TypeChartData.cells: TypeChartCellVM[]` → `rows: TypeChartRowVM[]`.
- **`example/pokedex/lib/loaders.ts`** (`typeChartLoader`): build
  `rows: TypeChartRowVM[]` (19 rows × 19 cells: a header row + one row per
  attacking type) instead of pushing into one flat `cells[]`. Cell `id` becomes
  per-row-stable (e.g. `${rowIdx}-${colIdx}`); row `id` = `String(rowIdx)`.
- **`example/pokedex/pages/TypeChart.tsx`**:
  ```tsx
  <div className="dex-tc">
    {rows.map((r) => (
      <div key={r.id} className="dex-tc__row">
        {r.cells.map((c) => (
          <div key={c.id} className={c.className} title={c.title}>
            {c.content}
          </div>
        ))}
      </div>
    ))}
  </div>
  ```
- **`example/pokedex/app.css`**: add `.dex-tc__row { display: contents; }` (next
  to the existing `.dex-tc` rule).

## Part 4 — Docs + memory

- **`example/pokedex/FRAMEWORK-GAPS.md`**: nested-`.map()` section → ✅ FIXED
  (verified + dogfooded); update the "สถานะรวม" open-items line to drop nested
  `.map()`.
- **`docs/architecture.md`** native-interactivity / native-route section: note
  nested `.map()` is supported on the native path.
- Remove the now-stale "เลี่ยง / not proven / S10" comments in
  `TypeChart.tsx`, `loaders.ts`, and `types.ts`.
- **Memory `native-route-authoring-constraints`**: record nested `.map()` is
  confirmed working (no longer "single `.map()` only").

## Tests

- **Compiler:** `cargo test -p jsx-rust-compiler` — the 5 new golden tests pass;
  no existing test regresses.
- **Runtime:** `bun test tests/jinja-route.test.ts` — nested-map route renders;
  existing NativeProfile + 404 + React-root assertions still pass.
- **Pokedex build:** `bun run runtime/cli/index.ts build example/pokedex/index.ts`
  compiles the nested-map `TypeChart.jinja` without error.
- **Visual:** browser smoke (chrome-devtools, pokedex `/type-chart` on port
  1337) — grid renders identically to the flat version (19×19, headers + cells,
  colours intact).

## Acceptance criteria

1. 5 compiler golden tests assert byte-exact nested jinja and pass.
2. Runtime render test proves nested-map native route renders correct HTML
   through the real server pipeline.
3. PokéDex type chart uses nested `.map()` (no flat `cells[]`), renders
   pixel-identical via `display: contents`.
4. CI gates green: `bun run ci` (biome), `cargo fmt --all --check`,
   `cargo clippy --workspace --all-targets --locked -- -D warnings`,
   `cargo test --workspace --locked`, full `bun test`.
5. FRAMEWORK-GAPS + architecture.md + memory updated; stale comments removed.

## Known limitations (unchanged by this work)

- `(item, idx)` two-arg map still `MapIndexParamNotSupported`.
- Bare-fragment map body still `MapShapeNotSupported`.
- No keyed-diff; native render is full re-render per request (native pages are
  static-data, server-rendered — no client diff anyway).

## Verification gotchas (from memory)

- TS lint gate is `bun run ci` (biome) from repo root — NOT tsc.
- No Rust runtime change here, so no napi rebuild needed; but the runtime test
  runs `brust build` (compiles fixtures via `target/{debug,release}/jsx-rustc`)
  in its `beforeAll` — `cargo build -p jsx-rust-compiler --bin jsx-rustc` must
  succeed first (the test does this itself).
- `brust build` dual-emits jinja to `dist/jinja` AND `cwd/.brust/jinja`; the
  pokedex must be rebuilt before a dev/source run picks up the new TypeChart.
- Run native render test files separately (documented ~1/5 port-race flake when
  combined).
