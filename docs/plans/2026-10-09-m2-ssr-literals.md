# M2a3 — ssr literal props and nested-list react children Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · base: `v2` @4ba3874

**Goal:** Close the two findings of Mellow's spot-check of `m2a2-ssr-props` (note 05c677eb): (1) a react child inside nested lists compiles silently to a 2-D `_ssr_…[_i1][_i2]` slot that the server cannot serve — it must be the `nested-instance` Error like every other nested instance; (2) a literal prop passed to a react child (`<Reviews limit={3}/>`) must reach the ssr job as a value, not become a `null` path that fails the build.

**Architecture:** two local compiler changes. The `nested-instance` check that already guards inlined children with jobs (`lower/template.rs` ~1084-1107) is extended to react children whose ssr job would be indexed by more than one loop. `JobDecl` gains `literals: BTreeMap<String, serde_json::Value>`: at the one site that builds a child's ssr job (`analyze/passes/children.rs` react arm, where `props` is filled since m2a2), a prop whose value is a JSON literal goes into `literals` and is omitted from `props`; `props` keeps paths and `null` only for computed values.

**Tech Stack:** Rust nightly per `rust-toolchain.toml`; `cargo test -p brust-compiler`; goldens via `BRUSTC_UPDATE=1 cargo test -p brust-compiler --test fixtures`.

**Spec:** `docs/design/2026-10-09-m2-server-design.md` S6 amendments ("ssr job `props`", "ssr job `literals`", "one level of per-row instances").

## Global Constraints

- `literals` is `#[serde(default, skip_serializing_if = "BTreeMap::is_empty")]`; only fixtures with literal react-child props change their `expected.ir.json`. Inspect every golden diff.
- A literal is: a string, number, boolean or `null` literal, or an array/object literal whose members are all literals (recursively). Template literals without substitutions count as strings. Anything else (identifiers, calls, arithmetic, conditionals) is NOT a literal and stays a `null` path (fail closed; the build lane rejects it with the prop name).
- Fail closed on nesting: the Error, never a wrong slot.
- Gates before every commit: `cargo fmt --all`, `cargo clippy -p brust-compiler -p brust-compiler-cli -p brust-jinja --no-deps -- -D warnings`, `cargo test -p brust-compiler`; after the last task `bun run battery` twice (no diff), `bun test scripts/battery`, `bun run browser-test`.
- Boundary: `crates/brust-compiler/**`, `tests/fixtures/**`, `docs/react-coverage.md`, `docs/plans/m1-exit-report.md`, `docs/plans/m1a-followups.md`.

## Review Focus

1. **Nested lists with a react child in the inner list** (`groups.map(g => g.items.map(it => <Reviews item={it}/>))`): `error nested-instance` from `--emit all`, exit 1 — Task 1 pins it (and a react child in ONE list still builds).
2. **A react child inside an inlined native child that itself is in a list** (grandchild react): also `nested-instance` — Task 1 pins it.
3. **Literal kinds**: `limit={3}`, `title="x"`, `on={true}`, `meta={{ a: 1, b: ['x'] }}` all land in `literals` with the exact JSON; `n={a + 1}` lands as `props.n = null` — Task 2 pins all five.
4. **A literal and a path for the same child**: `props` has the path, `literals` the literal, no key in both — Task 2 pins it.
5. **A react page's own job** keeps no `literals` (same as no `props`) — Task 2 pins it on `react-hook`.

---

### Task 1: react child in nested lists is `nested-instance`

**Files:**
- Modify: `crates/brust-compiler/src/lower/template.rs` (the `nested-instance` raise sites ~1084-1107 and the react child branch in `component()` ~931-975 where the `_ssr_<id>[idx]` index path is built: read how many loop indices the path carries)
- Create: `tests/fixtures/react-child-nested/input.tsx` (+ `Reviews.tsx` copied from `react-child-row`, `expected.diag.txt` only — lowering fails)
- Test: `crates/brust-compiler/tests/lower_template.rs`, `crates/brust-compiler/tests/review_edges.rs`

**Interfaces:**
- Consumes: the existing `Diagnostic::error("nested-instance", …)` text and remediation (reuse verbatim); the loop-index path builder the react branch uses.
- Produces: `--emit all` exits 1 with `error nested-instance …` for a react child under two or more enclosing loops, or under an inlined child that is itself per-row. `--emit ir` still exits 0 (lowering-time rule; map contract 9).

- [ ] **Step 1: Failing test** (append to `lower_template.rs`)
```rust
/// Spot-check 05c677eb: a react child under two loops cannot be served (one-level rule) → Error, not a 2-D slot.
#[test]
fn react_child_in_nested_lists_is_a_nested_instance_error() {
    let err = lower_err("react-child-nested");   // helper returning the lowering Diagnostic for a fixture; add it next to lowered_jinja if absent
    assert_eq!(err.rule, "nested-instance", "{err:?}");
    // and one level still works
    let jinja = lowered_jinja("react-child-row");
    assert!(jinja.contains("_ssr_reviews_"), "{jinja}");
}
```
- [ ] **Step 2: Fixture** `tests/fixtures/react-child-nested/input.tsx`:
```tsx
import Reviews from './Reviews'
export default function Groups(props: { groups: { id: string; items: { id: string; name: string }[] }[] }) {
  return <div>{props.groups.map((g) => <section key={g.id}>{g.items.map((it) => <Reviews key={it.id} item={it} limit={3} />)}</section>)}</div>
}
```
Run `BRUSTC_UPDATE=1 cargo test -p brust-compiler --test fixtures`; the runner writes `expected.diag.txt` (and no jinja) once Step 3 lands.
- [ ] **Step 3: Implement** — in the react child branch, count the enclosing `For` indices of the slot path; if ≥ 2, or if the component being lowered is itself an inlined per-row child, raise the same `nested-instance` Error the inlined-child path raises. Also pin the grandchild case with a `review_edges.rs` test (`ir`→lowering) using an inline source: parent list → native `Row` child (inlined) → `<Reviews/>` inside `Row`.
- [ ] **Step 4: Run, commit**
```bash
git commit -am "fix(compiler): react child under nested loops is nested-instance (one-level rule)"
```

---

### Task 2: `JobDecl.literals`

**Files:**
- Modify: `crates/brust-compiler/src/ir/decls.rs` (`JobDecl`), `crates/brust-compiler/src/analyze/passes/children.rs` (react arm: where `props` is filled since m2a2), `crates/brust-compiler/src/analyze/passes/tier.rs` (self-job: empty), `crates/brust-compiler/src/analyze/expr.rs` or wherever a `fn json_literal(&Expr) -> Option<serde_json::Value>` fits (search for an existing literal-to-JSON helper first — the `x-props` dict printer handles literals; reuse its classification)
- Regenerate: `tests/fixtures/react-child-row/expected.ir.json` (`limit` moves from `props: null` to `literals: {"limit": 3}`)
- Test: `crates/brust-compiler/tests/children.rs`

**Interfaces:**
- Consumes: the m2a2 `props` map construction (`children.rs`), the `single_path_or_none` helper.
- Produces: IR JSON `"literals": { "<prop>": <json> }` on child ssr jobs (absent when empty); `props` no longer contains literal props. Contract for m2c: copy `literals` into the manifest job record; the worker merges `literals` over the server-built inputs for ssr jobs (looked up by `<componentId>/<jobId>` from `JobCall.id`). The server is unchanged (literals are constant per job, so the key stays path-derived).

- [ ] **Step 1: Failing tests** (append to `tests/children.rs`)
```rust
#[test]
fn literal_react_child_props_go_to_literals_not_props() {
    let ir = ir_of(r#"
import Reviews from './Reviews'
export default function P(props: { a: { id: string } }) { return <Reviews item={props.a} limit={3} title="x" on={true} meta={{ a: 1, b: ['x'] }} n={props.a.id.length + 1} /> }
"#);
    let job = ir.jobs.iter().find(|j| matches!(j.kind, JobKind::Ssr { .. })).unwrap();
    let props = job.props.as_ref().unwrap();
    assert_eq!(props.get("item"), Some(&Some("a".into())));
    assert_eq!(props.get("n"), Some(&None), "computed values stay null paths: {props:?}");
    assert!(!props.contains_key("limit") && !props.contains_key("title"), "literals are not in props: {props:?}");
    assert_eq!(job.literals.get("limit"), Some(&serde_json::json!(3)));
    assert_eq!(job.literals.get("title"), Some(&serde_json::json!("x")));
    assert_eq!(job.literals.get("on"), Some(&serde_json::json!(true)));
    assert_eq!(job.literals.get("meta"), Some(&serde_json::json!({"a": 1, "b": ["x"]})));
}
#[test]
fn react_page_self_job_has_no_literals() {
    let ir = ir_of_fixture("react-hook");
    let job = ir.jobs.iter().find(|j| matches!(j.kind, JobKind::Ssr { .. })).unwrap();
    assert!(job.literals.is_empty() && job.props.is_none());
}
```
- [ ] **Step 2–3**: run (fails: no field `literals`), implement, regenerate `react-child-row` goldens (`literals: {"limit": 3}`), run all.
- [ ] **Step 4: Ledger** `docs/plans/m1a-followups.md`: add **F60** "computed (non-path, non-literal) react-child props are a build error in M2 (`ssr-prop-not-a-path`); M3: evaluate template-subset expressions server-side" owner M3. Commit:
```bash
git commit -am "feat(compiler): literal react-child props travel as JobDecl.literals (S6)"
```

---

## Verification (READY evidence, paste in the task note)

```
cargo fmt --all -- --check && cargo clippy -p brust-compiler -p brust-compiler-cli -p brust-jinja --no-deps -- -D warnings
cargo test --workspace --exclude bun_react_compiler       # green; paste children/lower_template counts
cargo run -q -p brust-compiler-cli -- tests/fixtures/react-child-nested/input.tsx --emit all --out /tmp/x; echo "exit=$?"   # error nested-instance, exit=1
cargo run -q -p brust-compiler-cli -- tests/fixtures/react-child-row/input.tsx --emit ir | python3 -c "import sys,json; print([(j.get('props'), j.get('literals')) for j in json.load(sys.stdin)['jobs']])"
bun run battery && bun run battery && git status --short docs/ && bun test scripts/battery && bun run browser-test
```
PR `lane/m2a3-ssr-literals` → `v2`, CI green, lane HEAD sha.

## Dispatch table (for the Coordinator)

| slug | plan tasks | tier | role | deps | review | acceptance (READY evidence) |
|---|---|---|---|---|---|---|
| `m2a3-ssr-literals` | 1–2 | routine | Implementer (Routine) | none (base `v2` @4ba3874) | standard | Verification block pasted with outputs; PR → `v2` CI green; lane HEAD sha |
