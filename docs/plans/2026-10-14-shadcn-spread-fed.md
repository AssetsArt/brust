# shadcn S1 — spread into a fed child: pagination and input-group (draft for the lead's ruling)

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · implementer: Guetta (lane `spread-fed`, proposed) · reviewer: Mellow · gates: Illenium · flow: lane → PR → CI → lead merges · ledger rows: F159 leftover (b) (becomes this lane), next free F164 · governed by `docs/plans/2026-10-14-react-parity-north-star.md`

Author: Guetta. Status: **RULED 2026-10-14 (see §10); lane may start.** Base: origin/main de1ae0dd (after #219; `icon-shapes` @d81266e8 is in review, not yet on main). R-numbers are proposals (R34.83–R34.87); the lead renumbers. Numbers are `docs/shadcn-coverage.json` on the `icon-shapes` tree, which differs from main only by the three icon rows (spinner, breadcrumb, button-alias); the two rows of this plan are identical on both.

## 1. Where it stands

Two pages still ship the React floor because ONE wrapper each is a React island:

| Page | JS (gzip) | React components | Blocker (compiler diagnostic) | Basis |
|---|---|---|---|---|
| pagination | 87 KB | `PaginationPrevious`, `PaginationNext` | `spread-props`: "props are spread into `<PaginationLink>`, which the server feeds per instance (a job or useId)" (`pagination.tsx` lines 73 and 90) | **confirmed**: `compileTree` diagnostics on the real fixture page, printed for this plan |
| input-group | 87 KB | `InputGroupInput` | the same message, into `<Input>` (`input-group.tsx` line 136) | **confirmed**, same method |

Everything else on both pages is already static or native: `PaginationEllipsis` and the three chevron/ellipsis icons inline since L23 and `icon-shapes` (the `external-component` lines a first-pass diagnostic prints for them disappear once the build has rendered the icons; the generated row says 2 React components for pagination, i.e. exactly Previous and Next). `InputGroupAddon` is native (a click handler), which stays; it needs the small runtime chunk, not React.

So this is a **real byte lane**: **174 KB** across two pages if both reach their floor-free state (pagination to 0 JS; input-group to the native runtime only, not measured here, so "87 → a few KB" is an estimate to be reported by the lane, not claimed). It is also the rule that blocks `InputGroupButton` in the library listing (not on a fixture page), and it is the largest single cause in the survey: `spread-props` is a blocker on 40 measured rows (180 library components); most of those rows stay islands for other reasons, so the byte claim is only these two pages.

## 2. Why the compiler refuses today (confirmed from `children.rs`)

A **fed** child (`ir::is_fed`) is a static/native child with a precompute job or `useId` values: every shadcn wrapper whose class is `cn(…, className)` or `buttonVariants({ variant, size })` is one. The server runs that job **per instance**, and the compiler binds each of the job's **input roots** at the call site (`InstanceRecord`: a props path, a literal, or a server expression; a root the call site does not pass is bound `__undefined`; the manifest refuses an unbound root).

`{...props}` at the call site has keys known only at render, so any of them could be a job input root (`size`, `isActive`, `className`). The rule at `check_spread` (`spreads_in && child.fed`) refuses every such call, whether or not a root could actually arrive that way. That is fail-closed and right, but too coarse: a spread can only carry the keys its source is **not destructured away**.

- `PaginationLink`'s job reads `className`, `isActive`, `size`. `PaginationNext` destructures only `className`, passes `size="default"` before the spread, and spreads the rest. So the spread can carry **`size`** (it would override `"default"`) and **`isActive`**, and nothing else the job reads.
- `Input`'s job reads `className` only. `InputGroupInput` destructures `className`, so its rest **cannot** carry any root: there is nothing to check.
- `InputGroupButton` (library only) passes `variant`, `size`, `className` to `Button` and destructures all three, so its rest cannot carry a root either.

## 3. Design

### 3.1 Rule (recommended): spread into a fed child, with the roots it can carry required absent at the call sites

For a call with a spread of this component's own props (`{...props}` / `{...rest}`) into a fed child, for every **input root `r` of the child's jobs**:

1. If `r` is written **after** the spread at this call, it wins, and is bound as today. Nothing to check.
2. Otherwise, if the spread may carry `r` (`spread_carries(r)`: the spread is this component's own props object, or its rest and `r` is not a named prop of this component), then **`r` joins this component's `absent_props`** and every call site of this component must not pass it. The call site check is `require_absent`, with its existing bubbling: a caller that itself spreads its own props passes the requirement up, a route root (props from the request) cannot satisfy it, a spread of unknown keys is a fallback.
3. If the spread is anything else (a props path, a call, a literal with unknown keys), the existing refusal stays.

The prop the spread does NOT carry as a root still reaches the fed child's template exactly as it does for a non-fed static child today (`spread_attrs` on the child's host element, R34.15/R34.16); only the job inputs needed the proof. The instance record stops binding the `...` entry as if it were an input (`kept` includes `SPREAD_KEY` today; the lane must skip it, and a test pins the manifest).

This is the mechanism F153c already has for `asChild` (`absent_props`, `require_absent`, `spread_carries`, Mellow-reviewed, PR #218), applied to a second kind of key. It adds **no runtime, no server and no manifest change**: the instance bindings are unchanged, because under the requirement the spread provably carries none of the roots, so `__undefined` for an unpassed root is exactly what React computes.

`absent_props` for the key needs a **strict** variant: today `require_absent` accepts a literal `false`/`undefined` written at the call site (right for `asChild`). For a job root that is wrong: `isActive={false}` or `size={undefined}` passed to `PaginationNext` would reach the job through the spread, which this design does not bind. The strict variant accepts only "not written".

### 3.2 Options not taken

| Option | What it does | Why not (v1) |
|---|---|---|
| B. Spread-aware job binding | bind each root as `__props.r if 'r' in __props else <explicit>`: a call site could pass `size` through the spread and still compile | needs a presence operator in `server_expr`, a manifest form for a spread-bound input, a brust-core planner/cache-key change, and a defence for `null` vs absent; **no fixture page needs it**. Revisit only on a real app. |
| C. Expand the spread at the caller | the caller knows its literal keys, so replace `...` by explicit entries when the chain is fully literal | changes the inlining order (a component is compiled once, not per call chain); a large change for the same two pages |
| D. Wait for F149 (fold `cva`/`cn` at build) | a fed child with literal inputs stops being fed | F149 folds only when the call-site inputs are literals; `className` from props is not. Independent; this lane stays useful after it. |

### 3.3 What does not change

No tier rule, no runtime, no bundler, no revive path, no manifest shape. A call site that passes a root through the spread (`<PaginationNext isActive />`, `<PaginationNext size="sm" />`) is a **named fallback**, not a build error: the page keeps that one wrapper as the React island of today.

## 4. Requirements

- **R34.83 Spread into a fed child.** §3.1 rule 1–3, with `absent_props` carrying the roots, strict "not written" at the call site, bubbling through components that spread their own props.
- **R34.84 The record never binds the spread.** `InstanceRecord` skips `SPREAD_KEY`; the manifest of a page with such a call is unchanged in shape; `UncoveredInput` stays impossible.
- **R34.85 Message.** The fallback names the key and the component: "`size` of `<PaginationNext>` reaches `<PaginationLink>`'s class job through a spread".
- **R34.86 Battery rows** (built AND served, HTML equal to the React build's, R34.3), §5.
- **R34.87 Proof and docs.** `docs/shadcn-coverage.*`, `docs/react-coverage.*`, `m1-exit-report.md` regenerated; the PR lists every page whose tier or code changes and the gzip delta; ledger F159 (b) closed or narrowed, F164.

## 5. Fail-closed list and battery rows

| Row | Input | Expected |
|---|---|---|
| spread, roots destructured | `Input`-shaped: `({ className, ...props }) => <Fed className={cn(…, className)} {...props} />`, caller passes `placeholder` | static; HTML equal to React's |
| spread, root not destructured, caller silent | `PaginationNext` shape, caller passes `href` | static; `absent_props` = `[isActive, size]` on the wrapper |
| caller passes a root | `<PaginationNext isActive />` and `<PaginationNext size="sm" />` | the wrapper is an island, message names the key; **served HTML equals React's** (the spread's `size` wins) |
| caller passes a root as a literal falsy | `<PaginationNext isActive={false} />`, `size={undefined}` | the same island (strict: not written) |
| explicit after the spread | `<Fed {...props} size="default" />` | static; the explicit value wins, no requirement |
| explicit before the spread, destructured | `InputGroupButton` shape | static; no requirement |
| requirement bubbles | `A` spreads its own props into `PaginationNext` which spreads into `PaginationLink` | `absent_props` on both; a caller of `A` passing `size` falls back |
| route root | a page component spreading `props` into a fed child | refused (request props satisfy nothing) |
| spread of a props path / call | `{...data.attrs}` into a fed child | unchanged refusal |
| whole props object | `{...props}` with no destructuring | every root is carried: all roots required absent |
| React-tier child | spread into an island | unchanged refusal |
| `useId`-fed child | a child with `useId` and a spread | static (no roots), id stable across the page |
| handler through the spread | `onClick` on the wrapper | the existing `spread-handler` rules apply, unchanged |

## 6. Proof

- **Expected to move:** pagination (87 → 0 KB, tier static, 0 islands) and input-group (87 → native runtime only). A move counts only if `brust build` succeeds, the page is **served** and its HTML equals the React build's for the changed subtree (R34.3).
- **Expected not to move:** every other row. The lane lists, row by row, every page whose codes change (the `spread-props` count falls where only this rule applied).
- **Reported, not gated:** gzip delta per moved row; the number of library components whose `spread-props` disappears (survey count, not bytes).

## 7. Boundary and gates

Boundary: `crates/brust-compiler/src/analyze/passes/children.rs` (`check_spread`, `require_absent` strict variant, the `InstanceRecord` loop), `crates/brust-compiler/tests/**`, `scripts/battery/rows.ts`, generated docs, ledger. **Nothing** in `brust-core`, the manifest, `packages/brust/src/build/**` or the runtime.

Gates: `cargo clippy` exactly as `ci.yml` (`-D warnings`), `cargo test -p brust-compiler -p brust-napi --no-fail-fast`, `packages/brust` tests, `bun test scripts`, battery (0 unexplained), `bun run shadcn` regenerated, the two pages served and compared with React's HTML, Chromium suites untouched. Reviewer: Mellow, **security pass** (the rule decides which keys may reach a server job: a forged key through a spread is the attack, §8.1).

Size: small, one lane, no new file; the review risk is the proof of "the spread cannot carry a root".

## 8. Risks

1. **A root reaches the job through a path the proof misses** (the spread is not the only way: a `...rest` of a rest, a forwarded `props` object, a renamed destructure `({ size: s, ...rest })`). Mitigated: `spread_carries` already encodes own-props/rest and named props; the lane adds battery rows for rename, nested rest and whole-props, and anything it cannot prove stays the refusal. This is the review focus.
2. **Spread order.** React applies later entries over earlier ones; a root written after the spread wins and one before it loses. Rows pin both orders, served and compared.
3. **`absent_props` on a wrapper changes who falls back.** A shadcn app that passes `size` to `PaginationNext` (documented as allowed by the type) gets an island for that one wrapper, as today, with a message instead of a generic one. No call site gets worse than it is now.
4. **Claims.** The doc says "expected"; the PR says what moved, with `jsGzipKb` per row. Input-group's remaining JS is reported as measured, not as 0.

## 9. Questions for the lead

- **Q1 Strict "not written" for a root.** Recommended (§3.1): `isActive={false}` or `size={undefined}` at a call site is a fallback, because the spread would carry it into a job the design does not bind. The alternative is option B (spread-aware binding), a server/manifest/cache change for no fixture benefit.
- **Q2 `InputGroupButton`.** It is a library row only (page `input-group` does not use it). In this lane as a battery row, at no extra rule; confirm, or leave it to the ledger.
- **Q3 Order.** Independent of `icon-shapes` (no shared files once it is on main) and of F149. Recommended: this lane next (certain, 174 KB, small), the hydration-timing plan after it.
- **Q4 Security pass.** Mellow's security pass on the key-carrying proof (§8.1), as for revive-hardening, because it decides which request-time keys feed a server job. OK?

## 10. Lead ruling (2026-10-14)

Accepted; R-numbers R34.83–R34.87 are confirmed for this lane (F149's plan starts at R34.88, the S2 context plan after it). Ledger row **F164**. Rulings on §9:

- **Q1 Strict "not written": yes.** Writing a root at a call site (`isActive={false}`, `size={undefined}`) falls back with a named code; option B (spread-aware binding) is not built.
- **Q2 `InputGroupButton`: a battery row in this lane**, no extra rule.
- **Q3 Order: this lane next**, then the hydration-timing draft.
- **Q4 Security pass: yes**, Mellow signs off the key-carrying proof (§8.1) as a gate, since it decides which request-time keys feed a server job.

**Amendment 2026-10-14 (ruling on Guetta's blocker, option A):** the spread proof alone turns two island fallbacks into a **build error** in lowering (`nested-instance`, open F53: a fed grandchild's slot key is built from the child printer's own counters, and `instances[]` records only the root's direct children). Valid React must never stop building, so the rule cannot ship alone. The lane is widened, not split, because the two pieces only pay together:
- **R34.96 Nested fed instances, non-loop.** One instance counter shared across the inline boundary (`lower/template.rs`), and the wrapper's instance records re-based onto the route root (`children.rs` substitutes the call-site props for the wrapper's props paths). If brust-core or the manifest form must change, the PR says so and Mellow reviews that part; the existing instance form is the first thing to prove.
- **R34.97 Loops stay refused**, and any nested case the lane cannot lower **falls back to React at analysis time** (named code), never `nested-instance` as a build error. A test pins that no valid shadcn page or battery row turns into a build error.
- **R34.98 Proof** stays the same: pagination and input-group served, HTML equal to React, 0 JS. F53 is closed for the non-loop case; the loop case stays open in the ledger.
Mellow's security sign-off now also covers the re-based records (which props reach which job).

**Amendment 2026-10-14 (PR 2 split, ruling on Guetta's sizing).** Job fusion (R34.96) is entangled with the cn-fold job module (`folded_instances`, ordinal skipping, `job_reads`) and with brust-core instance ordinals, so PR 2 ships as two PRs, owned by two people:
- **PR 2a (Guetta, lane `spread-fed-2`).** R34.83 spread rule, the static-wrapper re-base case, F169, tests and battery rows. No job-module edits. Any nested fed case it cannot lower falls back at analysis time (R34.97), so 2a ships on its own.
- **PR 2b (Dew, lane `spread-fed-fusion`, from main after 2a merges or stacked on it).** R34.96 job fusion: job module, template ordinals and brust-core instance ordinals, reconciled with cn-fold. **Contract first:** Guetta writes on the `spread-fed` task which instances fuse and the analysis output shape; Dew acknowledges it before coding. Guetta reviews the analysis side of 2b, and Mellow signs off on its security (which props reach which job).
- AspectRatio stays blocked until 2a merges. If Dew's `idle-workers` lane gets review findings, those come first.
