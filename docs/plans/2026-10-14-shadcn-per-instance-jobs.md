# shadcn S1 — lane `per-instance-jobs` (F142; draft for the lead's ruling)

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · implementer: Dew · reviewer: Mellow · gates: Illenium · flow: lane → PR → CI → lead merges · ledger row: F142

Author: Dew. Status: **RULED 2026-10-14 (see §8); lane may start after #202 merges.** Base: origin/main d426f540. Numbers come from `docs/shadcn-coverage.md` at that commit (2 measured rows carry `fallback:instance-list-path`, ranked #9; 0 analysis-only rows; 0 library components) and from reading the two pages and `tests/fixtures/shadcn/components/ui/{table,carousel,card}.tsx`. R-numbers continue after R34.41 (member-tag).

Depends on: #202 (spread-handlers), which binds a fed child's omitted props as `__undefined`. Without it, `TableRow` (no `className` at the call site) builds but `brust start` refuses the manifest (`UncoveredInput`).

## 1. What the diagnostic is today

A **fed** child is a native/static child with a precompute job or `useId` values (`ir::is_fed`). Every shadcn wrapper whose class is `cn(…, className)` is one: `cn` is a package import, so it is a per-instance precompute job.

- **Compiler.** `children.rs` records each inlined fed instance as an `InstanceRecord` with `loops = self.loop_sources` (`children.rs:780`). That is every enclosing list as a props path, or `None` when the list's source is not a plain props path.
- **Fallback.** Since rest-props, a `None` loop gives the PARENT the fallback `instance-list-path` (`children.rs:766`, ruling on challenge 4dc45c45), so the page renders as a React island. The build's throw stays as a backstop (`packages/brust/src/build/manifest.ts:243`).
- **Server.** brust-core plans every job once, from the request context, before any job runs (`pipeline.rs` ≈1750). A `per-row:<path>` child gets one job call per row of that path in the parent's props. A list that is not in the props (a module constant, a body local, a store, state, or a value derived at render) has no rows the planner can count.

## 2. The measured rows

| Row | Codes (generated) | Lists | Fed instances in the list | Does any instance's call-site prop read the row? |
|---|---|---|---|---|
| table | `instance-list-path` only | `invoices.map(…)` over a **module const** | `TableRow` (no props), `TableCell` ×4 (`className="font-medium"` / `"text-right"` / none) | **No.** Row data appears only as JSX children (`{i.invoice}`), which the page prints in its own loop |
| carousel | 10 codes, among them `instance-list-path` | `[1, 2, 3, 4, 5].map(…)`, an **inline array literal** | `CarouselItem` (key only), `Card` (none), `CardContent` (`className` literal) | **No.** `{n}` is children markup |

Both rows are **row-invariant**: every row's instance has the same job inputs, so the job's output is the same for every row. That is the whole F142 surface the scoreboard measures today.

The general case, a fed child whose props read the row over a list that is not a props path (e.g. `invoices.map(i => <Badge variant={i.status}>)`), appears in no fixture page. It is a common app shape, though, and the ledger row names it ("local const and store lists").

## 3. Design (recommended)

### 3.1 Row-invariant instances: fed once, read once (no server change)

- **Rule.** An inlined fed instance inside one or more lists is **row-invariant** when all of the following hold:
  - none of its call-site props reads a loop binding or a loop index (`Deps.loop_bindings` empty; a spread segment counts by what it reads);
  - it has no `useId` slots (ids must differ per row);
  - no enclosing list is client-rendered (no `x-for` row template; see §5).
- **Record.** A row-invariant instance gets `loops: []`: it is a **static** instance, with one job call per request (not one per row) and the same `__<id>_<k>` slot.
- **Lowering.** The printed slot read drops the row index. `Inline.slots` becomes `__{id}_{k}` instead of `__{id}_{k}{loops}` (`template.rs:1626`), and the loop's `var_used` is not marked.
- **Server.** Unchanged: `instances: "static"` is today's form.
- **Why the output equals React.** A precompute job is a function of its inputs; the job cache already assumes this (the key is the inputs). The same inputs give the same output, so printing one value in every row is exactly what React's N identical calls produce.

### 3.2 Constant lists: rows from the literal (manifest + brust-core)

- **Rule.** A fed instance that reads the row, in a single list whose source is a **compile-time constant array**, gets its rows from that literal. A constant array is either:
  - a module-level `const` that the placer already folds (`ModuleDecl.consts`, not `mutated`, a JSON literal), or
  - an inline array literal.
- **Compiler.** `InstanceRecord` gains `rows_literal: Option<serde_json::Value>`, absent otherwise, so existing IR and manifests stay byte-identical. The loop entry is the literal's marker.
- **Build (`manifest.ts` `childRecords`).** Emits `instances: "per-row-literal"` with `rows: [...]`. Instance `exprs` already evaluate over `__row`/`__idx` (F105), so a row-reading prop binds per row as today.
- **brust-core.**
  - `Instances::PerRowLiteral(rows)` (`manifest.rs`).
  - `ChildTpl.rows` becomes a list source: a props path or a literal (`pipeline.rs`).
  - `row_count` and `PropsMap::child`'s row binding read from the literal (`inputs.rs`).
  - The manifest version and the Cloudflare/wasm path follow the core, which both targets share.
- **Size cap.** The literal is capped (Q3). A larger constant keeps the fallback.

### 3.3 What stays fail-closed (the parent keeps `instance-list-path`, with a message naming the source kind)

| Source of the list, with a row-reading fed instance | Why not in v1 |
|---|---|
| derived from props at render (`items.filter(…)`, `.slice`, `.sort`, a body local computed from props) | rows exist only after a render step. Planning needs two phases (the parent's precompute output, then the child jobs) — Q5 |
| a store (`useStore`) | the client changes it, and rows the client re-creates cannot get server job outputs (F96d's class) |
| state | same |
| any list the client renders (`x-for`), even for a row-invariant instance | the zero-row template prints no slot values (F146) and new rows have no job output |
| nested lists | existing `nested-instance` (F53), unchanged |
| a `useId` child over a constant list | allowed by §3.2, since ids get the per-row suffix as with props lists; listed here only to pin it with a battery row |

## 4. Requirements (R34.42–R34.48)

- **R34.42 Row-invariant instances (§3.1).** Fed once per request as `static`; the slot read carries no row index; the output in every row equals the React build's. The rule holds for props-path lists too (Q1).
- **R34.43 Constant lists (§3.2).** A module `const` or an inline array literal feeds row-reading fed instances per row from the literal. The manifest form is additive. brust-core plans `row_count(literal)` calls, and `__row`/`__idx` bind as for props lists.
- **R34.44 Fail closed (§3.3).** Each remaining source keeps the parent fallback `instance-list-path`, with the source kind in the message ("a list derived at render", "a store list", …). `manifest.ts`'s throw stays the backstop.
- **R34.45 Compatibility.** No existing `expected.ir.json`, manifest or battery row changes, except where §3.1 turns a per-row props-path instance static (Q1). The battery records that change, if any.
- **R34.46 Battery.** Rows (no `knownGap`):
  - row-invariant over a module const → static;
  - row-invariant over an inline array → static;
  - row-reading over a module const → static, per-row-literal;
  - row-reading over an inline array → static;
  - `useId` child over a const → static;
  - list derived from props → react, `instance-list-path`;
  - store list → react;
  - state list with a fed child → react;
  - `b-fed-child-local-list` (rest-props), which flips react → static by R34.43 (its `Row` reads the row: `name={r.name}`).
- **R34.47 Proof.**
  - **table.** Predicted to flip react → **static**, with 0 islands and 0 KB client JS. Its SSR HTML is compared with the React build's (R34.3), and the page is **started** with `brust start`, not only built (the S1.3 lesson: the generator only builds).
  - **carousel.** Loses `instance-list-path`; its tier does not change, because nine other codes remain.
  - `docs/shadcn-coverage.md` is regenerated twice with identical results, and the PR names both rows.
- **R34.48 Honest leftovers.** Lists derived at render (Q5), store/state lists, and build-time evaluation of pure package calls (Q6) are ledger rows, not this lane.

## 5. Risks

1. **Purity.** §3.1 relies on a precompute job being a function of its inputs. That is already the job cache's contract, so a job that reads time or randomness is already wrong under caching. The lane adds no new assumption, but the PR says so.
2. **Client-rendered lists.** A list becomes `x-for` when its row binds something (a handler, state). A fed child in such a row is today a per-row props-path instance at best. §3.1 deliberately excludes these lists, so S1.3's handler-in-a-row case is not widened here (F146 first).
3. **Manifest compatibility (§3.2).** An older server rejects `per-row-literal` (an unknown `instances` string fails `Manifest::load` loudly). Server and manifest ship together, so this is acceptable; it is noted in the release notes.
4. **Literal size.** A large constant table goes into the manifest once (not per request). The cap keeps a pathological constant from bloating the manifest (Q3).

## 6. Boundary and gates

**Boundary.**
- `crates/brust-compiler/src/analyze/passes/children.rs` (records, fallback message), `lower/template.rs` (slot read), `ir/decls.rs` (`InstanceRecord.rows_literal`).
- `packages/brust/src/build/manifest.ts` (`childRecords`).
- `crates/brust-core/src/{manifest,pipeline,inputs}.rs` (§3.2 only).
- Tests in those crates and packages.
- `scripts/battery/**`, `docs/react-coverage.md`, `docs/plans/m1-exit-report.md`.
- `docs/shadcn-coverage.md` (regenerated), `docs/plans/m1a-followups.md` (F142).

`children.rs` and `template.rs` are shared with island-children, local-component and member-tag; the readiness-order merge rule applies.

**Gates (targeted).**
- `cargo fmt --check`, the CI clippy line (including the wasm targets for brust-core).
- `cargo test --workspace --exclude bun_react_compiler`.
- The battery, and `bun test scripts/battery`.
- `packages/brust` build-manifest / e2e / e2e-child-literals.
- `bun test scripts/shadcn`, and the generator twice, identical.
- A started-server HTML comparison of the table page against React.

Heavy runs are announced on the task first.

**Order.** It can start after #202 merges, in parallel with the other S1 lanes. §3.1 alone is a small compiler-only change: if the lead prefers, it can ship first as its own PR (it flips table), with §3.2 following (Q4).

## 7. Questions for the lead

- **Q1 Row-invariant for props-path lists too?** Recommended: **yes, one rule.** It means fewer job calls (N → 1 per request) and identical output. It can change existing manifests from `per-row:x` to `static` for instances whose props never read the row; the battery and e2e fixtures show whether any do.
- **Q2 Where the constant rows live.** Recommended: **in the manifest record** (`per-row-literal` + `rows`), read by brust-core. Alternatives:
  - inject the constant into the parent's request context: a hidden prop that every server path would have to add;
  - unroll the loop at compile time: the template and the slot numbering change shape.
- **Q3 Literal cap.** Recommended **64 KB** of JSON per list. A larger constant keeps `instance-list-path`, with a message saying to move it into a loader.
- **Q4 Split.** Recommended: **one lane, two commits**, with §3.1 first and gated alone. Alternatively, two PRs if the lead wants the table flip earlier than the brust-core change.
- **Q5 Lists derived at render** (`items.filter(…)` then fed children). Recommended: an **F-row** for two-phase planning. brust-core would evaluate the parent's precompute output, then plan child jobs per row of it, which changes the single-phase planner and the cache lookup. Not v1.
- **Q6 Build-time evaluation instead.** Every shadcn job in these rows is `cn(<literals>)`. Evaluating a pure package call once at build would remove the jobs entirely (L2 extended to package imports, R34.7's sibling). Recommended: an **F-row**. L2 v1 excludes package imports on purpose (a package may read the host), and this lane does not reopen that.

## 8. Lead ruling (2026-10-14)

The design is accepted. Rulings on §7:

- **Q1 Row-invariant for props-path lists too: yes, one rule.** Any existing manifest that changes from `per-row:x` to `static` is listed in the PR with the battery/e2e evidence that the output is identical.
- **Q2 Constant rows live in the manifest record** (`per-row-literal` + `rows`), read by brust-core. The other two options stay rejected.
- **Q3 Cap: 64 KB of JSON per list**, the same number as island-children's per-instance cap. A larger constant keeps `instance-list-path` with the "move it into a loader" message.
- **Q4 Split: two PRs on the one task.** PR 1 = §3.1 (compiler only, flips `table`), gated and merged alone, so the flip lands without waiting for the brust-core change. PR 2 = §3.2 (manifest + brust-core + wasm/Cloudflare path). Each PR is reviewed and gated on its own sha.
- **Q5 Lists derived at render: F-row** (two-phase planning), not v1.
- **Q6 Build-time evaluation of pure package calls: F-row, merged with local-component's `cva`/`cn` folding F-row** (one row for "fold `cn`/`cva` of literals at build", R34.4 as the target); whichever lane lands first writes it, the other references it.
- **Purity (risk 1):** the PR states the job-cache purity contract that §3.1 relies on, with a link to where it is already assumed.
