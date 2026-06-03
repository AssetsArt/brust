# Implementation plan — native nested `.map()` verify + lock-in + dogfood

Spec: `docs/superpowers/specs/2026-06-03-native-nested-map-verify-design.md`

## Spec coverage table

| Spec section | Task |
|---|---|
| Part 1 — compiler golden tests | Task 1 |
| Part 2 — runtime render fixture + test | Task 2 |
| Part 3 — pokedex dogfood | Task 3 |
| Part 4 — docs + memory | Task 4 |
| Acceptance: CI gates green | Task 5 (verify) |

No `lower.rs` / `emit_jinja.rs` lowering edits in any task. If a golden test
FAILS (output ≠ expected), STOP — the "no compiler change" premise is broken;
escalate, do not patch the compiler to match.

---

## Task 1 — Compiler golden tests (lock-in)

**File:** `crates/jsx-rust-compiler/src/lib.rs` (test module, `mod tests`, after
the existing `compile_full_*` tests, ~line 727+).

These are **characterization tests**: the feature already works, so they pass
immediately. They lock the byte-exact emitted jinja so any future lowering
regression flips them red. Use the in-scope `compile(src) -> Result<String,…>`
(lib.rs:11; `use super::*` is already at lib.rs:667).

Add exactly these 5 tests:

```rust
    #[test]
    fn native_nested_map_member_source() {
        let src = r#"export default function P({ rows }) {
  return <table>{rows.map((r) => (<tr>{r.cells.map((c) => (<td>{c.label}</td>))}</tr>))}</table>;
}"#;
        assert_eq!(
            compile(src).unwrap(),
            "<table>{% for r in rows %}<tr>{% for c in r.cells %}<td>{{ (c.label) | e }}</td>{% endfor %}</tr>{% endfor %}</table>"
        );
    }

    #[test]
    fn native_nested_map_inner_refs_outer_binding() {
        let src = r#"export default function P({ rows }) {
  return <table>{rows.map((r) => (<tr>{r.cells.map((c) => (<td>{r.type}:{c.label}</td>))}</tr>))}</table>;
}"#;
        assert_eq!(
            compile(src).unwrap(),
            "<table>{% for r in rows %}<tr>{% for c in r.cells %}<td>{{ (r.type) | e }}:{{ (c.label) | e }}</td>{% endfor %}</tr>{% endfor %}</table>"
        );
    }

    #[test]
    fn native_nested_map_three_levels() {
        let src = r#"export default function P({ groups }) {
  return <div>{groups.map((g) => (<section>{g.rows.map((r) => (<ul>{r.items.map((i) => (<li>{i.name}</li>))}</ul>))}</section>))}</div>;
}"#;
        assert_eq!(
            compile(src).unwrap(),
            "<div>{% for g in groups %}<section>{% for r in g.rows %}<ul>{% for i in r.items %}<li>{{ (i.name) | e }}</li>{% endfor %}</ul>{% endfor %}</section>{% endfor %}</div>"
        );
    }

    #[test]
    fn native_nested_map_binding_is_array() {
        let src = r#"export default function P({ matrix }) {
  return <table>{matrix.map((row) => (<tr>{row.map((cell) => (<td>{cell.v}</td>))}</tr>))}</table>;
}"#;
        assert_eq!(
            compile(src).unwrap(),
            "<table>{% for row in matrix %}<tr>{% for cell in row %}<td>{{ (cell.v) | e }}</td>{% endfor %}</tr>{% endfor %}</table>"
        );
    }

    #[test]
    fn native_nested_map_with_per_item_conditional() {
        let src = r#"export default function P({ rows }) {
  return <table>{rows.map((r) => (<tr>{r.cells.map((c) => (c.hot ? <td class="hot">{c.v}</td> : <td>{c.v}</td>))}</tr>))}</table>;
}"#;
        assert_eq!(
            compile(src).unwrap(),
            "<table>{% for r in rows %}<tr>{% for c in r.cells %}{% if c.hot %}<td class=\"hot\">{{ (c.v) | e }}</td>{% else %}<td>{{ (c.v) | e }}</td>{% endif %}{% endfor %}</tr>{% endfor %}</table>"
        );
    }
```

**Verify:**
```
cargo test -p jsx-rust-compiler native_nested_map
```
Expected: `test result: ok. 5 passed`. Then full crate:
```
cargo test -p jsx-rust-compiler
```
Expected: all pass, no regression.

**BLOCKED fallback:** if any expected string mismatches actual output, the
emitter changed since the spec repro — do NOT edit the compiler. Capture the
actual output, STOP, and escalate (the gap is no longer "already works").

---

## Task 2 — Runtime render fixture + test

Proves nested `{% for %}` renders through brust's real server pipeline.

**2a. New file** `tests/fixtures/app/pages/NativeNestedMap.tsx`:
```tsx
// Sub-project J — nested `.map()` native-render coverage. A native: true page
// whose template nests an inner `.map()` (r.cells) inside an outer `.map()`
// (rows). Proves minijinja renders nested `{% for %}` through the SAB pipeline.
export default function NativeNestedMap({
  rows,
}: {
  rows: { id: string; cells: { label: string }[] }[]
}) {
  return (
    <div className="grid">
      {rows.map((r) => (
        <div className="row" key={r.id}>
          {r.cells.map((c) => (
            <span className="cell" key={c.label}>
              {c.label}
            </span>
          ))}
        </div>
      ))}
    </div>
  )
}
```

**2b. Wire into** `tests/fixtures/app/routes.tsx`:
- Add import after line 12 (`import NativeProfile …`):
  ```tsx
  import NativeNestedMap from './pages/NativeNestedMap'
  ```
- Add a route object in the routes array, next to the NativeProfile route
  (after the `/_test/native-notfound/{user}` block, ~line 95):
  ```tsx
  // Nested `.map()` native-render coverage (verify gap).
  {
    path: '/_test/nested-map',
    Component: NativeNestedMap,
    native: true,
    loader: async () => ({
      rows: [
        { id: 'r0', cells: [{ label: 'a' }, { label: 'b' }] },
        { id: 'r1', cells: [{ label: 'c' }] },
      ],
    }),
  },
  ```

**2c. Append assertions** to `tests/jinja-route.test.ts` (after the existing
`test('GET / — HelloWorld …')` block at end of file):
```ts
test('GET /_test/nested-map — nested .map() renders nested HTML', async () => {
  const res = await fetch(`${BASE_URL}/_test/nested-map`)
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('text/html')
  const body = await res.text()
  // Outer map → 2 rows; inner map → 3 cells total (2 + 1), in order.
  expect((body.match(/class="row"/g) ?? []).length).toBe(2)
  expect(body).toContain('<span class="cell">a</span>')
  expect(body).toContain('<span class="cell">b</span>')
  expect(body).toContain('<span class="cell">c</span>')
  // 'a' before 'b' before 'c'.
  expect(body.indexOf('>a<')).toBeLessThan(body.indexOf('>b<'))
  expect(body.indexOf('>b<')).toBeLessThan(body.indexOf('>c<'))
})
```

**Verify:** (the test's `beforeAll` builds jsx-rustc + runs `brust build` on the
fixture, then boots brust on port 3801)
```
lsof -ti:3801 | xargs kill -9 2>/dev/null; bun test tests/jinja-route.test.ts
```
Expected: all tests pass including the new nested-map test; existing
NativeProfile/404/React-root assertions still green.

**BLOCKED fallback:** if the nested-map route 500s, capture the server log
(`RUST_LOG=brust=debug`) and the rendered body — the gap would be a runtime
render limitation, not just "no fixture". Escalate before changing the renderer.

---

## Task 3 — PokéDex dogfood (remove flatten)

Behavior-preserving refactor; verified by `brust build` + visual smoke.

**3a.** `example/pokedex/lib/types.ts` — replace the `TypeChartCellVM` doc
comment + `TypeChartData` block (current lines ~115-129):
```ts
/** One cell of the type chart. */
export interface TypeChartCellVM {
  id: string // stable key "row-col"
  className: string // "dex-tc__cell dex-tc__cell--super"
  content: string // "2", "½", "0", a type short-code, or ""
  title: string // tooltip
}

/** One row of the type chart (header row + one row per attacking type). The
 *  native template renders rows.map(r => r.cells.map(c => …)) — nested `.map()`
 *  is supported on the native path. */
export interface TypeChartRowVM {
  id: string // row index as string
  cells: TypeChartCellVM[] // 19 cells (1 head + 18)
}

export interface TypeChartData {
  rows: TypeChartRowVM[] // 19 rows (1 header + 18), each 19 cells
  teamProps: { teamInitial: TeamMember[] }
}
```

**3b.** `example/pokedex/lib/loaders.ts` — replace the flatten block
(lines ~241-298, from the `// Flatten …` comment through the `return {…}`) with:
```ts
  // Build the 19×19 grid as nested rows (header row + one row per attacking
  // type). The native template renders it with nested `.map()` — rows.map(r =>
  // r.cells.map(c => …)) — into the CSS grid (`.dex-tc__row{display:contents}`
  // keeps every cell a direct grid item, so the layout is unchanged).
  const rows: TypeChartData['rows'] = []

  // Header row: corner + 18 defending-type column heads.
  const headerCells: TypeChartCellVM[] = [
    { id: '0-0', className: 'dex-tc__corner', content: 'ATK ＼ DEF', title: 'Attacking ＼ Defending' },
  ]
  ALL_TYPES.forEach((def, j) => {
    headerCells.push({
      id: `0-${j + 1}`,
      className: `dex-tc__colhead dex-tc__colhead--${def}`,
      content: SHORT[def] ?? def.slice(0, 3).toUpperCase(),
      title: cap(def),
    })
  })
  rows.push({ id: '0', cells: headerCells })

  // One row per attacking type: row head + 18 effectiveness cells.
  ALL_TYPES.forEach((atk, i) => {
    const rel = relations[i]!
    const rowCells: TypeChartCellVM[] = [
      {
        id: `${i + 1}-0`,
        className: `dex-tc__rowhead dex-tc__rowhead--${atk}`,
        content: SHORT[atk] ?? atk.slice(0, 3).toUpperCase(),
        title: cap(atk),
      },
    ]
    ALL_TYPES.forEach((def, j) => {
      const mult = rel[def]
      const id = `${i + 1}-${j + 1}`
      if (mult === 2)
        rowCells.push({ id, className: 'dex-tc__cell dex-tc__cell--super', content: '2', title: `${cap(atk)} → ${cap(def)}: 2× (super effective)` })
      else if (mult === 0.5)
        rowCells.push({ id, className: 'dex-tc__cell dex-tc__cell--weak', content: '½', title: `${cap(atk)} → ${cap(def)}: ½× (not very effective)` })
      else if (mult === 0)
        rowCells.push({ id, className: 'dex-tc__cell dex-tc__cell--none', content: '0', title: `${cap(atk)} → ${cap(def)}: 0× (no effect)` })
      else
        rowCells.push({ id, className: 'dex-tc__cell', content: '', title: `${cap(atk)} → ${cap(def)}: 1×` })
    })
    rows.push({ id: String(i + 1), cells: rowCells })
  })

  return {
    rows,
    teamProps: { teamInitial: teamStore.list() },
  }
```
Add `TypeChartCellVM` to the type import at line 25 if not already imported:
`import type { DetailData, ListData, TypeBadgeVM, TypeChartCellVM, TypeChartData } from './types'`
(remove the now-unused flat `cells`/`Omit<…>` local var declaration).

**3c.** `example/pokedex/pages/TypeChart.tsx` — update the header comment (drop
"pre-flattened … nested maps aren't proven") and the destructure + render:
- Signature: `export default function TypeChart({ rows, teamProps }: TypeChartData)`
- Replace the `{cells.map(…)}` block with:
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

**3d.** `example/pokedex/app.css` — add after the `.dex-tc {…}` rule (line 1619):
```css
.dex-tc__row { display: contents; }
```

**Verify:**
```
bun run runtime/cli/index.ts build example/pokedex/index.ts
```
Expected: build succeeds; `example/pokedex/.brust/jinja/TypeChart.jinja` exists
and contains nested `{% for %}` (`grep -c "for " …/TypeChart.jinja` ≥ 2).

**BLOCKED fallback:** if `brust build` rejects the nested TypeChart (it should
not — proven in Task 1), capture the compiler error and escalate.

---

## Task 4 — Docs + memory

**4a.** `example/pokedex/FRAMEWORK-GAPS.md`:
- The "nested `.map()` บน native ไม่มี fixture ยืนยัน · เลี่ยงไว้ก่อน" section
  → retitle `✅ FIXED (verified + dogfooded)`; note it always compiled (5
  golden tests + runtime render test), and the type chart now uses nested
  `.map()` with `.dex-tc__row{display:contents}`.
- "สถานะรวม" open-items line (~line 30): remove `nested .map()` from the open
  list.

**4b.** `docs/architecture.md` — in the native-route / native-interactivity
section, add a line that nested `.map()` (`rows.map(r => r.cells.map(c => …))`)
is supported on the native path (member-source, outer-binding refs, 3-level,
per-item conditional).

**4c.** Remove stale comments referencing the flatten workaround / "not proven"
/ "S10" in `TypeChart.tsx` (top comment), `loaders.ts` (done in 3b),
`types.ts` (done in 3a).

**4d.** Memory `~/.claude/projects/-Users-detoro-code-brust/memory/native-route-authoring-constraints.md`:
update to record nested `.map()` is confirmed working (no longer "single
`.map()` only"); keep the MEMORY.md one-liner in sync.

**Verify:** `bun run ci` (biome) passes; no broken markdown.

---

## Task 5 — Final gate (orchestrator-run in Phase 6)

Run ALL of these fresh, in repo root, and confirm green:
```
bun run ci                                                            # biome
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cargo build -p jsx-rust-compiler --bin jsx-rustc                      # for native tests
bun test runtime/
bun test tests/jinja-route.test.ts
bun test tests/native-island.test.ts
bun test tests/native-island-ssr.test.ts
bun test tests/integration.test.ts
```
Plus visual browser smoke: boot pokedex
(`bun runtime/cli/index.ts dev example/pokedex/index.ts`, port 1337), open
`/type-chart`, confirm grid renders identically (19×19, headers, colours).
