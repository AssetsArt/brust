# M1 lead report — 2026-10-09

Outcome report for the human from the lead (Detoro). Every ruling below is also on the Conclave task record it names; the plans and the ledger are the canonical documents.

## What shipped (branch `v2`, HEAD `ede3c5f`)

| Lane | PR | Merge | Rounds | What |
|---|---|---|---|---|
| m1a-foundation-core / fixtures-docs / ci | #109–#111 | `50b3776` | 1 | Bun crate link (parser, AST, printer, React Compiler HIR), `brustc --emit parse\|hir`, CI |
| m1d-runtime-dom | #112 | `b8a9ee2` | 2 | `@brust/runtime-dom`: signals, `mount`, every `x-*` directive, reactive parent→child props |
| m1b1-ir-readers | #113 | `99aed54` | 2 | IR types, RawExpr/JSX/hooks readers, `brustc --emit ir\|diag`, 10 fixtures |
| m1b2-placement-tier | #114 | `77bbc4e` | 2 | deps, template subset, placement (Server / Precomputed / ClientOnly), precompute jobs, captures + server-only errors, child links, `cache()`, tier |
| m1c-lowering | #115 | `54ed5e9` | 2 | `brust-jinja` filters, template/server/client backends, `brustc --emit all`, dual-evaluation harness |
| m1d-runtime-fixes | #116 | `a492f55` | 1 | `x-for` source `path:bindings` (F29), `x-if` strips `hidden` (F30) |
| m1e-battery-harness | #117 | `ede3c5f` | 1 + spot-check | 60-row React battery → `docs/react-coverage.md`, `brustc --render`, 7 browser cases, `scripts/battery/exit.test.ts`, `docs/plans/m1-exit-report.md` |

Exit numbers on merged `v2`: 160 cargo tests, 44 runtime tests, battery 60 rows (20 static · 16 native · 18 react · 4 error · 2 compile error · 0 unexplained), dual-evaluation and browser harness green, all CI jobs (`rust`, `runtime-dom`, `battery`, `browser`) green.

## Rulings (all on task records; plans amended where noted)

1. React Compiler scopes: walk `reactive_fn.body`, `pruned: bool`, exhaustive terminal match (m1a).
2. M1b-1 unsure items 1–5 → m1b2 plan "Rulings carried over" items 1–5 (JSX inside opaque sources → tier react `jsx-outside-render`).
3. m1b2 challenges R6 (`Opaque` carries captures) and R7 (`client_imports: Vec<(source, imported)>`) upheld — plan items 6–7.
4. m1b2 review round 1: B1 lazy `useState` init placed by its result; B2 module-level helpers read transitively + `client_module_locals`; N1 exact JSX runtime symbols — all fixed in-lane.
5. m1c challenge (nested `x-for` source, `x-if` hidden clone) upheld; runtime fixes done NOW in `m1d-runtime-fixes` instead of M2.
6. m1c review round 1: B1 per-instance suffix on inlined-child loop bindings; B2 `truthy` filter for JS truthiness; B3 `style_css` for Server style values — fixed in-lane.
7. Battery triage: F37 memo unwrap (M2), F38 dynamic `import()` panic (M1 hotfix, in flight), F39 `useId` (M2 server), F40 `Array.from` (M2), F41 §8.1 warnings not emitted (M2; report must not claim them).
8. Process: the gate runner must `tell` the coordinator after every gate run; the coordinator dispatches reviewer and gates in parallel on READY (two 8-hour stalls traced to a note-only hand-off).

## Reviewer bar that held across all lanes

A blocker is "output that is silently wrong with no diagnostic". Fail-closed `Fallback` diagnostics are preferred over guessing. Every blocker got one pinned test.

## Where the records live

- Spec: `docs/design/2026-10-08-react-compiler-design.md` (rev 2) — §4.4 amended (client backend prints from IR).
- Plans: `docs/plans/2026-10-08-m1{a,b1,b2,c,d,e}-*.md` with their rulings/inputs sections; task plan bodies on Conclave.
- Ledger: `docs/plans/m1a-followups.md` F1–F41 (owner per item: M1 hotfix / M2 / M2 server).
- Generated reports: `docs/react-coverage.md`, `docs/plans/m1-exit-report.md` (CI fails on hand edits).

## Deferred / open

- F38 hotfix lane `m1-hotfix-dynamic-import` (knock2) also applies the spot-check wording fixes.
- M2 scope proposal: server integration (run jobs, per-component cache, minijinja render in brust-core), F32 (wrappers in table/select), F33/F34 cache + child jobs, F37/F39/F40/F41, runtime F10–F13, `bun check` when Bun 1.4.3 is stable (F8), publish workflow for `@brust/*` using `BRUST_NPM_TOKEN`.

## Scrutiny 2026-10-09

A scrutiny of the M1 exit claim found the gates proved less than `docs/plans/m1-exit-report.md` said. Six findings:

1. The battery ran `brustc --emit ir` only (analysis, no lowering), so spec §12 "no build error" was never tested.
2. A free-text `knownGap` string exempted a row and nothing pinned which rows were gaps.
3. Dual eval returned early (pass) without `bun`, skipped fixtures without samples silently, and matched `x-for` rows by position only.
4. No fixture put a native child with `x-props-bind` inside an `x-for` row ("keyed list with child props" was untested).
5. The browser harness captured only `console.warn`, only during mount; `console.error`, interactions and observer-driven mounts were invisible, and `warnOnce` never reset between cases.
6. The exit report's §12 paragraph was hard-coded prose.

The lead's manual `--emit all` sweep of all 61 rows on `v2` @720e6d7 found no hidden defect: 56 ok / 4 refused / 0 failed (the lead's first count said 57; it included the parse-error row). The gate now records the same split mechanically: 56 rows build ok, 4 error rows are refused, and the parse-error row never reaches lowering. Closed by `m1-gate-hardening` PR #119 (lane @98f4f24, merged into `v2` as b7e3869); the gaps it deliberately leaves are ledger F43-F47.
