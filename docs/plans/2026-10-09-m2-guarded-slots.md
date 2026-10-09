# M2a4 — guarded precompute slots never 500 (ledger F67) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · base: `v2` @fcd7faa

**Goal:** `{props.show && <b>{fmt(props.n)}</b>}` must render an empty branch when `show` is false, not a 500. Today the precompute job skips the slot inside a false guard, the job result has no `_s1`, and the server fails the render (Mellow's repro `m2eA/repo/examples/tiny`: show=true → 200, show=false → 500 `precompute result has no "_s1"`, no build warning). This is the most common React pattern and the pokedex had to work around it (`examples/pokedex/pages/DetailPage.tsx:25-26`).

**Architecture:** two guards, belt and braces. Compiler: the generated `precompute()` (`crates/brust-compiler/src/lower/server.rs`) always returns EVERY declared output slot — a slot whose enclosing guard is false is `null` (and per-row slots keep their array length). Server: a missing slot is `undefined` under the existing `UndefinedBehavior::Chainable`, never an error, logged once per (component, slot) at `warn` (`crates/brust-server/src/pipeline.rs`, the `precompute result has no` site). The template already guards the branch with `{% if … %}`, so a `null` slot is never painted.

**Tech Stack:** Rust; `cargo test -p brust-compiler --test lower_server` (+ fixtures), `cargo test -p brust-server`.

**Spec:** compiler spec §4.4 (precompute outputs), server spec §7 (errors); ledger F67 (`docs/plans/m1a-followups.md:131`, owner moves M3 → M2 by this lane).

## Global Constraints

- Byte-identical paint for every existing fixture (the job output gains keys, the HTML does not change): `cargo test -p brust-compiler --test fixtures` passes; goldens for `expected.server.ts` change only by the added `null` slots — inspect every diff.
- The dual-evaluation gate stays green (`--test dual_eval`): client first paint equals the server paint with the guard false.
- No change to job keys/inputs (F33 semantics untouched).
- Gates: `cargo fmt`, `cargo clippy --workspace --exclude bun_react_compiler --no-deps -- -D warnings`, `cargo test --workspace --exclude bun_react_compiler`, `bun run battery` (no diff), `bun run browser-test`.
- Boundary: `crates/brust-compiler/src/lower/server.rs`, `crates/brust-compiler/tests/{lower_server.rs,dual_eval.rs}`, `tests/fixtures/guarded-slot/**`, `crates/brust-server/src/pipeline.rs` (the missing-slot site only), `crates/brust-server/tests/**`. NOT `docs/plans/m1a-followups.md` (m2e owns it; the lead closes F67 after merge).

## Review Focus

1. **Guard false on first paint, true after a click** (state guard `open && fmt(n)`): the server paints nothing, the client computes the value on toggle — Task 1's fixture has both a prop guard and a state guard; the browser case clicks.
2. **Per-row guarded slot** (`items.map(it => it.sale && fmt(it.price))`): the array keeps one entry per row with `null` for non-sale rows — Task 1 pins the server.ts output.
3. **Nested guards** (`a && b && fmt(x)`): one `null` when either is false — Task 1 pins it.
4. **Server tolerance with an OLD job module** (a `dist/jobs.js` built before this change): a missing slot is `undefined`, the page is 200, one `warn` line — Task 2 pins it with a fake job result lacking the key.
5. **No warning spam**: the warn is once per (component, slot) per process — Task 2 pins it (two requests, one line).

---

### Task 1: Compiler — every output slot is present

**Files:**
- Modify: `crates/brust-compiler/src/lower/server.rs` (the precompute body printer: find where guarded slots are emitted inside `if` — grep `_s` and the guard/`If` handling; emit `const _sN = <guard> ? <expr> : null` at the top level of the job so the returned object always has the key; per-row: `map` returns `null` for rows whose guard is false)
- Create: `tests/fixtures/guarded-slot/input.tsx`, `money.ts` (copy from `nested-list`), `sample-props.json`, goldens
- Create: `tests/browser/cases/guarded-slot.test.ts` (add to `BROWSER_CASES` in `scripts/battery/exit.ts`)
- Test: `crates/brust-compiler/tests/lower_server.rs`

- [ ] **Step 1: Fixture**
```tsx
import { useState } from 'react'
import { fmt } from './money'
export default function Card(props: { show: boolean; n: number; items: { id: string; sale: boolean; price: number }[]; a: boolean; b: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      {props.show && <b className="p">{fmt(props.n)}</b>}
      <button onClick={() => setOpen(!open)}>toggle</button>
      {open && <i className="s">{fmt(props.n * 2)}</i>}
      <ul>{props.items.map((it) => <li key={it.id}>{it.sale && <em>{fmt(it.price)}</em>}</li>)}</ul>
      {props.a && props.b && <u>{fmt(props.n + 1)}</u>}
    </div>
  )
}
```
`sample-props.json`: `{ "show": false, "n": 5, "items": [{ "id": "x", "sale": false, "price": 1 }, { "id": "y", "sale": true, "price": 2 }], "a": true, "b": false }`.
- [ ] **Step 2: Failing tests** (`lower_server.rs`)
```rust
#[test]
fn every_output_slot_is_present_even_when_its_guard_is_false() {
    let (job_js, outputs) = server_ts_and_outputs("guarded-slot");            // helper: the fixture's expected.server.ts + JobDecl.outputs
    let result = run_job_under_bun(&job_js, "sample-props.json");          // the dual-eval harness already runs jobs under bun; reuse it
    for slot in &outputs { assert!(result.get(slot).is_some(), "slot {slot} missing: {result}"); }
    assert_eq!(result["_s1"], serde_json::Value::Null, "prop guard false → null");
    let rows = result[&outputs[2]].as_array().expect("per-row slot is an array");
    assert_eq!(rows.len(), 2); assert!(rows[0].is_null()); assert!(!rows[1].is_null());
}
```
(Name the per-row slot by reading the fixture's `expected.ir.json` outputs; the test must not hard-code `_s3` if the numbering differs.)
- [ ] **Step 3**: implement; regenerate goldens (`BRUSTC_UPDATE=1 …`); confirm `expected.jinja` for every fixture is byte-identical (`git diff --stat tests/fixtures -- '*.jinja'` empty) and only `*.server.ts` changed.
- [ ] **Step 4**: browser case: load → `after === before`, no `.p` (show false), click toggle → `.s` appears with `fmt(10)`; `li` 1 has no `em`, `li` 2 has `em`. `bun run browser-test` green.
- [ ] **Step 5**: commit `fix(compiler): precompute returns every output slot (null under a false guard) — F67`.

---

### Task 2: Server — a missing slot is undefined, warned once

**Files:**
- Modify: `crates/brust-server/src/pipeline.rs` (the `precompute result has no "<slot>"` error site → insert `Value::Null`/undefined for the slot, `tracing::warn!` once per (component_id, slot) via a `Mutex<HashSet<(String,String)>>` on `Server`, count it in stats as `missing_slots`)
- Test: `crates/brust-server/tests/` (append; fake job result that omits a declared output)

- [ ] **Step 1: Failing test**
```rust
#[test]
fn a_job_result_missing_a_declared_slot_renders_200_and_warns_once() {
    let fake = FakeBun::new(default_loader, |call| json!({ "results": [{ "id": call.jobs[0].id, "value": {} }] }));   // no _s1
    let s = boot(fake);
    assert_eq!(get(&s, "/pokemon/a").0, 200);
    assert_eq!(get(&s, "/pokemon/a?nocache=1").0, 200);
    assert_eq!(stats(&s)["missing_slots"], 1, "counted once per (component, slot)");
}
```
- [ ] **Step 2–3**: implement; `cargo test -p brust-server`; commit `fix(server): missing precompute slot is undefined, warned once (F67 belt)`.

## Verification (READY evidence)

```
cargo test --workspace --exclude bun_react_compiler && git diff --stat origin/v2 -- 'tests/fixtures/*.jinja'   # tests green; no jinja golden changed
bun run battery && bun run battery && git status --short docs/ && bun run browser-test                        # guarded-slot case passes
```
PR `lane/m2a4-guarded-slots` → `v2`, CI green, lane HEAD sha.

## Dispatch table (for the Coordinator)

| slug | plan tasks | tier | role | deps | review | acceptance (READY evidence) |
|---|---|---|---|---|---|---|
| `m2a4-guarded-slots` | 1–2 | routine | Implementer (Routine) | none (parallel to m2e; disjoint boundary) | standard | Verification block pasted; PR → `v2` CI green; lane HEAD sha |
