# M1e — React coverage battery, browser harness, M1 exit criteria Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure the compiler against ordinary React authoring (a ~60-row battery compiled through the real `brustc`, reported as `docs/react-coverage.md` with the tier and job count per row), and prove the generated artifacts work in a real browser (a static harness page that mounts the chunks of the spec's example components over the jinja-rendered HTML) — the two exit criteria of spec §12.

**Architecture:** `scripts/battery/` is a Bun script that owns the battery rows (snippet + expected tier) and drives `brustc --emit ir`/`diag` per row, writing the report deterministically. `tests/browser/` is a Bun + happy-dom (or Playwright if available) harness that renders each example's jinja with the `brust-jinja` filters (through a tiny `brustc --render <sample-props.json>` debug command added here), serves the HTML + chunks from a temp dir, mounts `packages/runtime-dom`, and asserts interactions.

**Tech Stack:** Bun 1.4.x, happy-dom (already a runtime-dom devDependency), minijinja via `brustc --render` (Rust), no new Rust crates.

**Spec:** §11 (battery, runtime tests), §12 (exit criteria), `docs/react-coverage.md` format from 0.1.x (`main` branch, `scripts/react-coverage.ts`) as the model for the report.

## Global Constraints

- The battery compiles each row through the real `brustc` binary (built by `cargo build -p brust-compiler-cli` in the script), never through a re-implementation.
- Report is deterministic: rows in file order, no timestamps except the brustjs version line; CI regenerates it and fails on diff (`git diff --exit-code docs/react-coverage.md`).
- Expected tiers in the battery come from the spec (§3 table, §4.3 hook table); a row whose observed tier disagrees with its expectation is marked `⚠` in the report **and** fails the battery test unless the row is tagged `known-gap` with a reason.
- Browser harness uses only the generated artifacts plus `packages/runtime-dom/dist/index.js`; no hand-written page logic beyond assertions.
- `brustc --render` is a debug command: it must not be used by any production path (documented in `--help`).

## Review Focus

1. **A row whose snippet fails to parse** must appear in the report as `compile error` with the message, not abort the whole battery — Task 1 pins it.
2. **The report must not depend on machine paths or hash salts**: component ids in the report are replaced by the row's name — Task 1 pins it with a fixed-string snapshot of two rows.
3. **Harness pages must assert first-paint equality**: the rendered HTML before mount and the DOM after mount (no changes) must be identical for every example — Task 3 pins it (the runtime's mismatch tripwire from M1d must not fire).
4. **Per-item handlers and child links in a list** in the browser (click row 2 of a keyed list, reorder, click again) — Task 3 pins it on the keyed-list example.
5. **Exit criteria are checked by code**, not by reading: Task 4's test asserts the expected rows are `native/static`, that `react` rows have a diagnostic, and that every example harness passes.

---

### Task 1: Battery script and report

**Files:** `scripts/battery/rows.ts` (the ~60 rows: `{ id, category, authoring, snippet, expect: 'static'|'native'|'react'|'error', note?, knownGap? }`), `scripts/battery/run.ts`, `docs/react-coverage.md` (generated), `package.json` script `battery`

Categories and rows (port the 0.1.x battery's A–E categories into v2 expectations): A JSX basics (text, interpolation, attributes, className template literal, style object, `&&`, ternary, fragment, list with keys, nested list, conditional attribute via ternary, `Array.from`); B composition (child static, child with props, children slot, component map dispatch → react in M1, `memo()` wrapper → native if plain, `forwardRef` → react, HOC → react); C hooks (`useState`, `useEffect` with cleanup, `useMemo`, `useCallback`, `useRef` + `ref=`, `useId`, `useLayoutEffect`, `useReducer` → react, `useContext` → react, custom hook → react); D API surface (`cache()` → native, `lazy`+`Suspense` → react, `createContext` → react, `cloneElement` → react, `Children.map` → react); E v2 specifics (precompute props-only, precompute state-dependent, per-item precompute, reactive props to child, function prop to child, function prop to react child → error, server-only import in handler → error, browser global in render → react client-only, request prop → error, missing key → error, `'use client'` leftover → warning, fragment root → warning).

Report columns: Pattern · Authoring · Expected · Observed tier · Jobs · Diagnostics (rule names) · Note. Summary table per category: counts of static / native / react / error and ⚠ rows.

Commit `feat(battery): react coverage battery over brustc with generated docs/react-coverage.md`.

---

### Task 2: `brustc --render <sample-props.json>`

**Files:** `crates/brust-compiler-cli/src/main.rs`, `crates/brust-compiler/src/lower/render_debug.rs` (minijinja env via `brust_jinja::register`, context = props + slots from running the server job through `bun`? No — keep Rust-only: `--render` takes a second JSON file `slots.json` produced by the M1c harness script `tests/harness/eval.ts`, so the pipeline is `eval.ts` → `slots.json` → `brustc --render props.json slots.json`), test in `crates/brust-compiler-cli/tests/cli.rs`.

Commit `feat(brustc): --render debug command (jinja + props + slots → html)`.

---

### Task 3: Browser harness

**Files:** `tests/browser/harness.ts`, `tests/browser/cases/{theme-toggle,product-card,parent-counter,keyed-list,controlled-input}.test.ts`, `package.json` script `browser-test`

For each example: build artifacts with `brustc --emit all --out <tmp>`; compute slots with `tests/harness/eval.ts`; render HTML with `brustc --render`; load the HTML into happy-dom (`document.body.innerHTML = html`), register the chunk by `import()` of the generated `client.js` (with `--runtime-import` pointing at `packages/runtime-dom/src/index.ts`), `mount()`; assert: (a) `document.body.innerHTML` unchanged after mount (Review Focus 3); (b) interactions: theme-toggle click flips the label text; product-card `+` updates total text via `fmt`; parent-counter button updates the child's text and `onReset` function prop works; keyed-list per-item click receives the right item, reorder keeps DOM nodes; controlled-input typing updates state and setting state updates the input.

If Playwright is installed (`bunx playwright --version` succeeds) run the same cases in Chromium against a static file server; otherwise happy-dom only (print which).

Commit `test(browser): harness mounting generated chunks over jinja-rendered HTML`.

---

### Task 4: Exit-criteria test and docs

**Files:** `scripts/battery/exit.test.ts` (bun test: regenerate the report, assert no ⚠ rows without `knownGap`, assert every `react` row has ≥1 diagnostic, run the browser cases), `README.md` (how to run battery/browser tests), `.github/workflows/ci.yml` (jobs `battery` and `browser`; battery job diffs the report), `docs/plans/m1-exit-report.md` (generated summary: counts + known gaps list) committed by the lane.

Commit `ci: battery and browser jobs; M1 exit report`.

---

## Self-review notes

- **Spec coverage:** §11 battery/runtime tests → Tasks 1, 3; §12 exit criteria → Task 4; `docs/react-coverage.md` deliverable → Task 1.
- **Review Focus → tests:** 1, 2 → Task 1; 3, 4 → Task 3; 5 → Task 4.
- **Soft spots:** happy-dom vs Chromium differences for `x-model` events; Playwright availability on CI (optional path).

## Dispatch table (for the Coordinator)

| slug | plan tasks | tier | role | deps | review | acceptance (READY evidence) |
|---|---|---|---|---|---|---|
| `m1e-battery-harness` | 1–4 | standard | Implementer (Standard) | `m1c-lowering` merged | standard | `bun run battery` regenerates `docs/react-coverage.md` with no diff on second run; `bun test scripts/battery/exit.test.ts` green; `bun run browser-test` green (paste counts); `docs/plans/m1-exit-report.md` pasted; PR -> v2 CI green (all jobs); lane HEAD sha. |
