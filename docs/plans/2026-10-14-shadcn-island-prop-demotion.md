# shadcn S1 — lane `island-prop-demotion` (draft for the lead's ruling)

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · implementer: TBD (lead assigns) · reviewer: TBD · gates: Illenium · flow: lane → PR → CI → lead merges · ledger row: F138g (proposed)

Author: Tiësto. Status: **DRAFT, awaiting ruling; no lane starts before the lead rules.** Base: origin/main 700955bd. Numbers are from `docs/shadcn-coverage.md` at that commit. R-numbers continue after R34.55 (constant-slots). The lead ruled (constant-slots §10 Q4) that `island-prop` demotes the host to React instead of failing the build, as its own small lane.

## 1. What the diagnostic is today

`crates/brust-compiler/src/analyze/passes/children.rs`, `Walker::component`, for a child that resolved to the **React tier** (an island): each prop that is a function (`Expr::ClientOnly`), reads state, or reads a store pushes `island_err("island-prop", "prop `k` passed to the React island <X> is …")`; a React child inside a list that changes with state pushes the same rule. `island_err` is `Diagnostic::error`, except while a lucide icon is still pending its second compile (`pending_icon`, a warning). An `Error` class diagnostic refuses the build (`brust build` exits 1; `brustc` exits 1).

The origin is the placement plan (`2026-10-08-m1b2-placement-tier.md` §3.2 rule 4): an island hydrates from a JSON props object, so a parent that is static or native cannot hand it a function or a live value. At that time the compiler had no way to say "then render the parent with React", so it refused. Every other construct the compiler cannot place natively since then became a **Fallback** (`tier.rs`: any non-child-only `Fallback` makes the component React) and the ruling of challenge 4dc45c45 (F142) says valid React never becomes a build error. `island-prop` is the remaining hard error on valid React.

## 2. Measured: what it blocks

| Where | Rows | Detail (`docs/shadcn-coverage.md` + a read-only probe) |
|---|---|---|
| shadcn pages, analysis-only | 2 | `calendar`: prop `components` (an object of inline components) on `<DayPicker>` at `calendar.tsx:31:5`; `form`: prop `render` (a function) on `<FormField>` at `form.tsx:11:9` |
| library components (blocker #20) | 9 | `CheckboxProvider`, `RadioProvider`, `RadioGroupItemProvider`, `SelectProvider`, `SliderThumbProvider`, `SwitchProvider`, `Group`, `Sankey`, `Treemap`: a `Context.Provider value={state}` is an island prop |
| battery | 3 | `d-profiler` (`<Profiler onRender>`), `e-member-island-prop`, `e-function-prop-react-child`, all `expect: error` today |

**The probe (a one-line prototype, `island_err` → `Diagnostic::fallback`, never committed; `brustc` on the two fixture pages):**

- **form:** the page is *already* React (`hook-unsupported`: `useForm`). So `<FormField render={…}>` is not an island at all: the whole page is rendered by React, and React hands a function to a component the way React always does. The error fires on a host that is already React. That is a plain bug, not a design limit.
- **calendar:** `Calendar` is *already* React (the props `...rest` object is read as a value, `prop-pattern`), and the page is static with one `Calendar` island and JSON props. Same bug: the `DayPicker` prop is a function inside a component that React renders anyway.

So both refusals are the same defect: `island-prop` is raised while analysing a **host that is React for another reason** (or that the very same diagnostic would make React). Neither row gains tier or bytes (they were refused, not built: 62 → 64 built; both end `react`, 1 island); the win is "the build no longer fails on valid React".

## 3. Design (recommended): island-prop is a fallback of the host

Change the class of the two `island-prop` diagnostics from `Error` to `Fallback`. Nothing else in the pass changes:

- **Host static/native, a function or live value reaches an island** (the case the error was written for): the host becomes React (`tier.rs`, "first non-child-only fallback"). React renders the whole subtree, including the child, with the function: correct by construction, no JSON boundary left. Its own parents see it as a React child as before (JSON props → island, or they demote in turn when they hand it a function).
- **Host already React** (form, calendar): the fallback is redundant and harmless; the `island-prop` line stays in the diagnostics list as the reason a reader of `docs/react-coverage.md` sees for the child. The tier reason keeps the first fallback in source order.
- **`pending_icon`** (a lucide icon whose second compile may inline it): unchanged, still a warning.

This is the same move F142 made for `instance-list-path` (hard error → fallback, "valid React never becomes a build error"), and the same move every unsupported construct already makes.

**Why not "drop the diagnostic when the host is React".** Tempting (it removes the redundant line) but the pass runs before `tier`, so it cannot know the final tier; reordering passes is a bigger change than the bug deserves. A fallback is correct in both cases and needs no ordering.

**Why not keep the error behind a strict option.** There is no user for it: the error refused valid programs; `--strict` today only governs static loaders. If a user wants to know which pages ship React, the coverage tools (`docs/react-coverage.md`, the shadcn scoreboard) already say it. Q2.

## 4. Requirements (R34.56–R34.60)

- **R34.56 Fallback, not error.** Both `island-prop` sites (function / reactive / store value on a React child; a React child in a list that changes with state) push `Diagnostic::fallback`; the host's tier becomes React through the existing rule. The messages and the `pending_icon` warning are unchanged.
- **R34.57 No false island.** A host that is React renders its component children with React: no `Ssr` job is created for them, no `island-prop` is evaluated against their props beyond the line above. (Today the `ok = false` path already skips the job; the lane adds a test that a React host with a function prop to a child emits no job and builds.)
- **R34.58 The refused rows build.** `calendar` and `form` build (`Outcome: built`), end `react` with the island count the generator measures, and appear in the Measured table (62 → 64 of 64 built; Analysis-only becomes empty). The "refused" columns and the ranked blocker #20 (`error:island-prop`) disappear from the generated scoreboard; the generator's `island-prop`-only assertion in `scripts/shadcn/run.test.ts` is replaced by "no row is refused".
- **R34.59 Battery rows** (§5): the three `error` rows become `react` rows (no `knownGap`); a row per host tier shows the demotion.
- **R34.60 Proof and docs.** `docs/shadcn-coverage.md` and `docs/react-coverage.md` regenerated (twice identical); the `<Profiler>` API line in `docs/react-coverage.md` is regenerated from its rows (its status may move from partial); `docs/plans/m1a-followups.md` gets F138g.

## 5. Fail-closed list and battery rows

There is nothing left to refuse: every case becomes a React host. The rows pin the behaviour so it cannot regress to an error:

| Row | Shape | Expect |
|---|---|---|
| `e-function-prop-react-child` (existing) | native host with state, function prop to a React child | `react` (was `error`) |
| `e-member-island-prop` (existing) | function prop on a member island | `react` (was `error`) |
| `d-profiler` (existing) | `<Profiler onRender>` | `react` (was `error`) |
| new: static host, function prop | `<Child onReset={() => {}}/>` in a stateless component | `react` |
| new: state value to a React child | `<Child count={n}/>` with `useState` in the host | `react` |
| new: store value to a React child | `useStore` value to a React child | `react` |
| new: React child in a stateful list | `.map` over state with a React child | `react` |
| new: host already React | `useForm`-style unsupported hook + function prop to a child | `react`, no `Ssr` job, builds |
| new: JSON props only (control) | literals / props paths to a React child | `static`, 1 job (unchanged) |
| new: lucide icon with a reactive prop | pending icon, second compile inlines it | still a warning, host unchanged |

## 6. Proof — the rows that move

- `calendar`, `form`: analysis-only → measured, `react`. Their island count and gzip KB come from the generator (a prediction, not a claim: `form` is React page-wide; `calendar` is a static page with one `Calendar` island).
- No other shadcn row changes tier (the probe on the other 62 pages is the generator's before/after table in the PR).
- Library numbers: the 9 `error:island-prop` components report `react` instead of `error` in the Libraries table (analysis-only).
- Battery: 3 existing rows `error` → `react`; Summary "error" column drops by 3.

## 7. Boundary and gates

Boundary: `crates/brust-compiler/src/analyze/passes/children.rs` (the two `island_err` sites) and its tests (`crates/brust-compiler/tests/children.rs` `function_and_reactive_props_to_an_island_are_errors`, which asserts `Error` today), `scripts/battery/rows.ts` + `docs/react-coverage.md` + `docs/react-coverage.json` + `docs/plans/m1-exit-report.md` (regenerated), `scripts/shadcn/run.test.ts` + `docs/shadcn-coverage.md` (the refused-rows assertions and regeneration), `docs/plans/m1a-followups.md` (F138g). It does not touch `lower/*`, `packages/brust` or `brust-core`.
Gates (targeted): `cargo test -p brust-compiler`, clippy `-D warnings` (CI form), fmt; the battery script; `bun test scripts/shadcn scripts/battery`; the shadcn generator twice identical; a served-page check of `calendar` and `form` (`brust build` + `brust start` + fetch 200, as local-component's `slot-parity` does: a page can build and still be refused by the server). Heavy runs announced on the task first.

## 8. Risks

1. **A page gets slower where it used to be refused.** Not a regression (it did not build). Pages that *used* to build with an island-prop warning (a pending icon) are unchanged.
2. **A genuinely stateful host becoming React where an island would have been better.** The error had no better outcome (it refused). A later lane can narrow the demotion (compile the host and pass the function through a registered handler); the fallback message already names the prop.
3. **Test churn.** One Rust test and three battery rows assert the error. They are the contract being changed, listed in §5/§7.
4. **A React host SSR path with a function prop.** The host renders with React on the server (`Ssr` job of the host itself); the function lives in the React tree and never crosses the JSON boundary. The served-page check in §7 is the evidence.

## 9. Questions for the lead

- **Q1 Fallback in both cases?** Recommended: yes (§3): one rule, no pass reordering; the redundant line on an already-React host is harmless and informative.
- **Q2 A strict option that keeps the error?** Recommended: no (§3).
- **Q3 Battery expectation of the three rows.** They go `error` → `react` with no `knownGap`. OK?
- **Q4 Scoreboard.** With no refused rows the Analysis-only table and ranked blocker #20 disappear from the generated doc. Keep an empty "Analysis-only (0 of 64 pages refused)" section so the generator shape is stable, or drop it? Recommended: keep it (fewer generator changes).
- **Q5 Order.** Independent of constant-slots (different lines of `children.rs`, `rows.ts`); the second to be ready merges `origin/main` in and regenerates the two docs, as for the last lanes.
