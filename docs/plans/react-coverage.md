# Plan: React authoring coverage report for native pages/components

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro, Lead) · authority: in-loop
implementer: assigned via conclave task `react-coverage`
escalation: design/spec conflicts → `conclave task challenge` on the task; Detoro rules.

## Goal (human's direct order, 2026-08-05)

Survey how much of ordinary React authoring (React 18/19/latest — the repo peers
`react@^19.2.6`) the NATIVE pipeline supports: which constructs inline to jinja,
which fall back to React SSR, which are client-only by design. Deliverable is a
**generator script + committed Markdown report**, so coverage is measurable,
regenerable, and the GAP list becomes the backlog for "support React authoring
as much as possible". This round is SURVEY + REPORT ONLY — closing gaps is
follow-up work planned from the report, not this task.

## Deliverables

1. `scripts/react-coverage.ts` — run as `bun scripts/react-coverage.ts`.
   Compiles a battery of small self-contained .tsx snippets through the REAL
   native pipeline and classifies each, then writes the report. Deterministic
   output (stable ordering, no timestamps beyond a single "generated at
   <version>" line using the package.json version, NOT wall-clock) so re-runs
   diff cleanly. Exit 0 always — it is a report generator, not a gate.
2. `docs/react-coverage.md` — the generated report, committed. Layout:
   summary counts up top (INLINE / FALLBACK-BY-DESIGN / GAP per category and
   total), then one table per category: pattern name, tiny code excerpt,
   status, and the compiler's warning text for non-inlined rows. Close with a
   "Gaps" section listing every GAP row with a one-line why-it-matters — this
   section is the follow-up backlog.

## Mechanism (settled — do not re-derive)

- Compile through the same path the CLI uses. Reference:
  `runtime/cli/native-routes-emit.ts` (calls compileJsx through the napi addon
  `runtime/index.js` + `runtime/brust.<platform>.node`) and the harnesses in
  `tests/native-inline.test.ts`. If driving the addon directly is awkward for
  multi-file cases, shell out to `cargo run -p jsx-rust-compiler --bin
  jsx-rustc` the way `tests/native-inline.test.ts` pre-flights — implementer's
  choice, but the compile MUST be the real compiler, not a reimplementation.
- Each battery entry: `{ id, category, code, expected: 'inline' |
  'fallback-by-design' | 'gap', note }`. Snippets live INLINE in the script as
  template strings (no fixture-file sprawl); multi-file entries (cross-file
  component import) may write to a temp dir under the script's control.
- Classification of an actual run: INLINED when no `not inlined` warning for the
  route and the emitted jinja contains the entry's marker string; FALLBACK when
  the warning fires (capture its exact reason text into the report).
- `expected` vs actual mismatch does NOT fail the script — it renders as a
  highlighted row (regression signal for humans), because the report must stay
  generatable while gaps exist.

## Battery taxonomy (settled scope — implementer may ADD rows, not remove)

A. JSX basics: element + text, expression interpolation, string/expr attributes,
   className, style object, conditional `&&`, ternary, explicit `<Fragment>`/`<>`,
   `.map` list with key, nested elements, JSX comments `{/* */}`, boolean/null/
   undefined children dropped.
B. Composition: same-file helper w/ props, helper w/ JSX children (0.1.69-alpha
   feature — element/fragment/nested), cross-file imported component, component-
   as-prop (`icon={Files}` → `<Icon/>`), JSX-valued props (`content={<p/>}`),
   spread props `{...props}`, destructure defaults (`{x = 1}`), helper w/
   children DEFAULT value (`{children = <span/>}` — known warn), `props.children`
   non-destructured (known warn), layouts/Outlet.
C. Hooks (expected fallback-by-design → SSR slot or island): useState,
   useEffect, useMemo, useCallback, useRef, useContext, custom hook. Note in the
   report that hooks belong to islands/behavior (`export const behavior`) in the
   brust model.
D. React API surface: `memo(Comp)`, `forwardRef` (18 idiom), ref-as-prop (19
   idiom), `lazy`+`Suspense`, `createContext`/Provider, `use()` (19),
   `cloneElement`, `Children.map`.
E. React 19 specifics: document metadata hoisting (`<title>`/`<meta>` inside a
   component), ref cleanup functions (client-only — classify), actions/
   useActionState/useOptimistic (client-only), `use(promise)`.

For every row the `note` says WHY the status is acceptable or a gap, one line.
Statuses must be honest: a construct that could plausibly inline statically but
warns today is a GAP, not "by design", even if inconvenient.

## Gates

1. `bun run ci` (biome).
2. `bun scripts/react-coverage.ts` runs green twice; second run produces zero
   diff in `docs/react-coverage.md` (determinism check:
   `git diff --exit-code docs/react-coverage.md` after the re-run).
3. `cargo fmt --all --check` if any Rust is touched (it should NOT be — this
   task is TS + docs only; needing Rust means escalate, don't drift).
4. Addon freshness trap: run `cd runtime && bun run build:debug` BEFORE the
   coverage run — a stale gitignored `runtime/*.node` silently reports the OLD
   compiler's coverage.

## Risk ledger

- Warning capture: `formatCompilerWarning` in `runtime/cli/native-routes-emit.ts`
  prefixes text; strip the prefix so the report shows the raw compiler reason.
- Some constructs fail at BUILD (compile error) rather than warn+fallback —
  the classifier needs a third actual-state `error` and must not crash the
  whole battery on one bad snippet.
- Don't let the battery leak temp dirs; clean up even on failure.
- Boundary is scripts/ + docs/ + (if needed) a small test; do NOT touch
  compiler crates, runtime/cli, or existing fixtures.
