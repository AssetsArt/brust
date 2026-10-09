# M1 gate hardening — make the exit gates prove what the exit report claims

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · base: `v2` @720e6d7

**Goal:** A 2026-10-09 scrutiny of the M1 exit claim (`docs/plans/m1-exit-report.md`) found that the gates check less than the report says. Nothing was found broken (the lead ran all 61 battery rows through `--emit all` by hand: 57 lower cleanly, the 4 `error` rows refuse to build), but five holes let a future regression pass green. This lane closes them and makes the report say only what the tests check. It is the first task before M2 (it replaces F42 as the first M2 task; F42 follows).

**Architecture:** no compiler change. Everything is in the three gate layers: `scripts/battery/` (Bun), `crates/brust-compiler/tests/dual_eval.rs` + `tests/harness/eval.ts` (Rust + Bun), `tests/browser/` (Bun + happy-dom) plus one new fixture `tests/fixtures/keyed-list-child/`.

**Tech Stack:** Bun 1.4.2 (`bun test`), cargo (nightly per `rust-toolchain.toml`), happy-dom via `packages/runtime-dom` devDependency.

**Spec:** §12 exit criteria (`docs/design/2026-10-08-react-compiler-design.md:690-712`). Scrutiny findings live in the lead report section "Scrutiny 2026-10-09" (Task 6 adds it).

## Global Constraints

- Every gate still runs the real `brustc` binary and real minijinja; no re-implementation of the compiler in a test.
- Reports stay deterministic and regenerated: `bun run battery` twice in a row produces no diff; CI's `git diff --exit-code` step is unchanged.
- No `knownGap`, allowlist, or skip may be free text: each exemption is a pinned entry a test compares by set equality, so adding or removing one changes a test, not only a string.
- A gate that cannot run (missing `bun`, missing job file, unparsable brustc output) FAILS; it never returns early or swallows. The only allowed skip is `BRUST_DUAL_EVAL_SKIP=1`, documented in the test's doc comment, never set in CI.
- Do not touch `crates/brust-compiler/src/**`, `crates/brust-compiler-cli/src/**`, `packages/runtime-dom/src/**` except the one test-only export in Task 5 (`warn.ts`). A real compiler or runtime defect found while doing this lane is a ledger row (`docs/plans/m1a-followups.md`), not a fix in this lane; file it as a task note and continue.
- Run `cargo fmt --all` and `cargo clippy -p brust-compiler -p brust-compiler-cli -p brust-jinja --no-deps -- -D warnings` before every commit that touches Rust.
- Commit per task with the message given; one PR from `lane/m1-gate-hardening` to `v2`.

## Review Focus

1. **Battery lowers every row** (`--emit all`), and a row whose lowering fails is a battery failure, not a silent pass — Task 1 pins it with a classification unit test.
2. **Exemptions are pinned sets**: known-gap rows, error rows and the browser case list are compared by set equality against constants in `scripts/battery/exit.ts` — Task 2.
3. **Dual eval fails closed**: missing `bun` is a failure; every sampled fixture contributes checks or is pinned in a `NO_DIRECTIVES` set; x-for row counts are compared — Task 3.
4. **The spec's "keyed list with child props" is exercised end to end** in the browser: a native child in an `x-for` row receives per-item props through `x-props-bind` with row scope, its per-item handler updates the parent, and the parent's state flows back into the child's class — Task 4.
5. **Browser warnings are caught wherever they happen**: `console.error` as well as `console.warn`, during mount AND interactions, with `warnOnce` reset per case; `after === before` asserted in every case — Task 5.
6. **The exit report is computed, not narrated**: the §12 paragraph and gap ids derive from the pinned sets — Task 6.

---

### Task 1: Battery lowers every row (`--emit all`)

**Files:** `scripts/battery/run.ts`, `scripts/battery/run.test.ts`, `docs/react-coverage.md` (regenerated), `docs/plans/m1-exit-report.md` (regenerated)

Today `compile()` runs only `brustc input.tsx --emit ir` (`run.ts:43`), which stops after analysis (`crates/brust-compiler-cli/src/main.rs:176-209`); lowering and codegen run only for `--emit template|server|client|all`. Spec §12 says "no build error" for every row, so the gate must lower.

- [ ] In `compile()`, after the `--emit ir` run succeeds and the IR JSON is parsed, run a second spawn: `brustc input.tsx --emit all --out <dir>/out` in the same temp dir. Classify it with a new pure function `classifyBuild(status: number | null, stderr: string, hasErrorDiag: boolean): Build` where `type Build = 'ok' | 'refused' | 'failed'`:
  - `status === 0` → `'ok'`
  - `status === 1 && hasErrorDiag && !/panicked at/.test(stderr)` → `'refused'` (an `Error` diagnostic refuses the build by design — see `main.rs` where `compile_tree` returns the error)
  - anything else (non-zero without an Error diagnostic, `panicked at`, `null` status = signal) → `'failed'`, with `buildMessage` = first non-empty stderr line.
- [ ] Add `build: Build` and `buildMessage?: string` to `Result`. Set `warn = true` when `build === 'failed'`, or when `build === 'refused'` and `observed !== 'error'`, or when `observed === 'error'` and `build !== 'refused'` (an error row must refuse). `knownGap` does NOT exempt a `failed` build (a crash is never a documented gap).
- [ ] Add a `Build` column to the coverage report row (`ok` / `refused` / `failed: <message>`) between `Jobs` and `Diagnostics`; add a `build failed` count to the per-category summary table and the total.
- [ ] `run.test.ts`: unit-test `classifyBuild` with four inputs (status 0; status 1 + Error diag; status 1 + no diag; status 101 + `thread 'main' panicked at …`) and assert the four outcomes. Keep the existing tests.
- [ ] Regenerate both reports (`bun run battery`), then run `bun run battery` again and confirm `git status` is clean for the two docs.
- [ ] Expected result on `v2` @720e6d7: 57 rows `ok`, 4 rows `refused` (`e-function-prop-react-child`, `e-server-only-handler`, `e-request-prop`, `e-missing-key`), 0 `failed`; the `e-parse-error` row stays `compile-error` (it never reaches the second spawn).

Commit `test(battery): lower every row with --emit all; a failed build is a battery failure`.

---

### Task 2: Pin the exemption sets and drop the tautologies

**Files:** `scripts/battery/exit.ts`, `scripts/battery/exit.test.ts`, `scripts/battery/rows.ts`

Today any row passes if `rows.ts` gives it a `knownGap` string over 10 characters (`run.ts:69`, `exit.test.ts:20`), nothing pins which rows are gaps, two assertions can never fail (`exit.test.ts:33-37`: `observed === 'error'` already implies an `error:` diagnostic, `run.ts:55-58`), and two native/static rows have no job assertion.

- [ ] In `exit.ts` export the pinned sets:
  ```ts
  /** Rows whose observed tier is accepted to differ from (or whose checks are relaxed against) the spec, by ledger id. Set-equal to the rows carrying `knownGap`. */
  export const KNOWN_GAP_ROWS: Record<string, { ledger: string; observed: Expect }> = {
    'a-nested-list':  { ledger: 'F32', observed: 'static' },
    'e-if-in-table':  { ledger: 'F32', observed: 'native' },
    'b-memo':         { ledger: 'F37', observed: 'react' },
    'c-useid':        { ledger: 'F39', observed: 'react' },
  }
  /** Rows that must produce an `Error` diagnostic and refuse to build. */
  export const ERROR_ROWS = ['e-function-prop-react-child', 'e-server-only-handler', 'e-request-prop', 'e-missing-key'] as const
  export const COMPILE_ERROR_ROWS = ['e-parse-error'] as const
  ```
  Verify the four `observed` values against the current `docs/react-coverage.md` before committing; if a value differs, the report is the truth and the table is wrong.
- [ ] `exit.test.ts`: replace the `knownGap.length > 10` assertion with: the set of row ids carrying `knownGap` equals `Object.keys(KNOWN_GAP_ROWS)`; for each, `observed === KNOWN_GAP_ROWS[id].observed` (a gap row that regresses further, or that silently gets fixed, now fails and forces the table to change); the set of rows with `expect === 'error'` equals `ERROR_ROWS` and each has `build === 'refused'`; the set with `expect === 'compile-error'` equals `COMPILE_ERROR_ROWS`.
- [ ] Delete the test `every row expected native/static compiles so, with the expected job count` (it is a strict subset of the `warn` test) and the two tautological error-row assertions. Keep the `fallback:` diagnostic assertion for `react` rows.
- [ ] `rows.ts`: make the job count mandatory for native/static rows at the type level: `type Row = RowBase & ({ expect: 'native' | 'static'; jobs: number } | { expect: 'react' | 'error' | 'compile-error'; jobs?: never })`. Fill in `jobs` for `c-usestate-load` and `d-cache` (both currently produce 1 precompute job per the coverage report; confirm from the regenerated report, not from this sentence). `bun build --no-bundle scripts/battery/rows.ts` must pass (CI's syntax step).
- [ ] Add a comment at the top of `rows.ts` stating the rule: an `expect` value cites the spec row in `note` (e.g. `note: 'spec §3 memo()'`) for every native/static row; add those notes to rows that lack one. (This is documentation discipline, not a test; the pinned sets are the test.)

Commit `test(battery): pin known-gap, error and compile-error row sets; drop tautological assertions`.

---

### Task 3: Dual eval fails closed and compares list shape

**Files:** `crates/brust-compiler/tests/dual_eval.rs`, `crates/brust-compiler/tests/harness/eval.ts`

Today: missing `bun` prints a warning and returns, so the test passes (`dual_eval.rs:114-117`; cargo hides stderr on pass). Fixtures without `sample-props*.json` are skipped silently (`dual_eval.rs:39`). The only coverage guard is `total >= 15` (`dual_eval.rs:180-183`). `eval.ts` skips an `x-for` whose attribute does not match its regex (`eval.ts:65` `continue`) and matches rows by position, so a server paint with 0 rows against a client list of N is never noticed.

- [ ] `dual_eval.rs`: replace the early return with `panic!("bun not on PATH; dual evaluation cannot run (set BRUST_DUAL_EVAL_SKIP=1 to skip locally)")` unless `std::env::var("BRUST_DUAL_EVAL_SKIP").as_deref() == Ok("1")`. Document the variable in the test's doc comment. Do not set it anywhere in `.github/`.
- [ ] Add a pinned set `const NO_SAMPLES: &[&str]` of fixture directories that intentionally carry no `sample-props*.json` (on @720e6d7: `arrow-default, client-only, fragment-root, import-cycle, jsx-shapes, lazy-import, missing-key, react-child, react-hook, server-leak`), and assert set equality between it and the fixtures actually skipped. A new fixture without samples must be added to the set deliberately.
- [ ] Add a pinned set `const NO_DIRECTIVES: &[&str]` (on @720e6d7: `static-text, cached-card`) and assert that every other sampled fixture contributed at least 1 check; keep the `total >= 15` floor.
- [ ] `eval.ts`: an `x-for` attribute that does not match the regex is an error (`throw new Error(\`x-for not parseable: ${raw}\`)`), not a `continue`. Align the regex with the runtime's (`packages/runtime-dom/src/directives/for.ts:9`): copy the runtime's `SYNTAX` expression verbatim with a comment naming the source line.
- [ ] `eval.ts`: emit one extra check per `x-for` source: the number of server-painted sibling rows (the `same` array at `eval.ts:66`, excluding the `hidden` template) must equal the client list length. Report it as a mismatch entry like the existing directive mismatches so `dual_eval.rs` counts and prints it.
- [ ] Run `cargo test -p brust-compiler --test dual_eval -- --nocapture` and paste the `dual evaluation: …` line and the total count in the task note. Then run it once with `PATH=/usr/bin:/bin` (no bun) and confirm it FAILS with the new message; then with `BRUST_DUAL_EVAL_SKIP=1` and the same PATH and confirm it passes.

Commit `test(dual-eval): fail without bun, pin skipped fixtures, compare x-for row counts`.

---

### Task 4: `keyed-list-child` fixture and browser case (spec §12 "child props")

**Files:** `tests/fixtures/keyed-list-child/input.tsx`, `tests/fixtures/keyed-list-child/Row.tsx`, `tests/fixtures/keyed-list-child/sample-props.json`, `tests/fixtures/keyed-list-child/expected.*` (generated), `tests/browser/cases/keyed-list-child.test.ts`, `scripts/battery/exit.ts` (`BROWSER_CASES`), `tests/fixtures/README.md`

Spec §12 names "a keyed list with per-item handlers and child props". `tests/fixtures/keyed-list/input.tsx` has no child component and no fixture has an `x-props-bind` inside an `x-for` row, so the runtime's row-scope path (`packages/runtime-dom/src/props-bind.ts:6-10,22`) is untested. The lead verified on @720e6d7 that the compiler handles this shape natively (parent `input`, child `Row` inlined into the row with `x-props-bind="_p1:t"`), so this is a test gap, not a compiler gap.

- [ ] `input.tsx` (exactly this shape; the names matter for the assertions):
  ```tsx
  import { useState } from 'react'
  import Row from './Row'
  export default function TodoList(props: { todos: { id: string; title: string }[] }) {
    const [selected, setSelected] = useState<string | null>(null)
    return (
      <ul className="todos">
        {props.todos.map((t) => (
          <Row key={t.id} title={t.title} selected={t.id === selected} onPick={() => setSelected(t.id)} />
        ))}
      </ul>
    )
  }
  ```
  `Row.tsx`:
  ```tsx
  export default function Row(props: { title: string; selected: boolean; onPick: () => void }) {
    return <li className={props.selected ? 'selected' : ''} onClick={props.onPick}>{props.title}</li>
  }
  ```
  `sample-props.json`: `{ "todos": [{ "id": "a", "title": "Write" }, { "id": "b", "title": "Ship" }, { "id": "c", "title": "Rest" }] }`
- [ ] Generate goldens with the fixture runner's update mode (`BRUSTC_UPDATE=1 cargo test -p brust-compiler --test fixtures`); read `expected.diag.txt` and confirm it is empty (tier native, no fallback) and `expected.jinja` contains `x-props-bind="_p1:t"` (or the equivalent `_pN:t`) inside the `<brust-row …>` wrapper. If the diag is not empty, stop and file a task note with the diagnostic — the plan's premise is wrong and the lead rules.
- [ ] `tests/browser/cases/keyed-list-child.test.ts`, modelled on `keyed-list.test.ts`:
  1. `load(build('keyed-list-child'))`; assert `warnings` is `[]` and `after === before`.
  2. Assert `$$('li').map(l => l.textContent)` is `['Write', 'Ship', 'Rest']` and no `li` has class `selected`.
  3. Click the second `li`; assert only the second `li` has class `selected` (child handler → parent `setSelected` → parent state → child `selected` prop through `x-props-bind`), and its text is unchanged.
  4. Reorder: set the parent's `todos` prop to `[c, a, b]` the way `keyed-list.test.ts:16-18` does (through `instanceOf(...)` and the props signal); assert the DOM order is `['Rest', 'Write', 'Ship']`, the `selected` class is still on the `Ship` row, and clicking the first `li` (now `Rest`) moves `selected` to it.
  5. After all interactions assert `warnings` is still `[]` (this needs Task 5's live warnings array; if Task 5 is not yet merged in your lane, do Task 5 first).
- [ ] Add `'keyed-list-child'` to `BROWSER_CASES` in `exit.ts` (the exit test asserts `across ${BROWSER_CASES.length} files`). Add the fixture to `tests/fixtures/README.md` in the same style as its neighbours.
- [ ] `bun run browser-test` → `9 pass` across 8 files; `cargo test -p brust-compiler --test fixtures` and `--test dual_eval` green (the new fixture has samples, so it must contribute checks under Task 3's rule: the list rows and `x-bind-class`).

Commit `test(browser): keyed-list-child fixture — per-item child props and handlers through x-props-bind`.

---

### Task 5: Browser harness catches every warning, for the whole case

**Files:** `tests/browser/harness.ts`, `tests/browser/cases/*.test.ts`, `packages/runtime-dom/src/warn.ts`, `packages/runtime-dom/test/*` (only if an existing warn test needs the reset)

Today `load()` captures only `console.warn`, only during chunk import and the synchronous `mount()` (`harness.ts:90-95`). The runtime reports `init threw`, `cleanup threw` and `chunk load failed` on `console.error` (`mount.ts:26`, `instance.ts:43`, `registry.ts:34`), interactions run after `console.warn` is restored, MutationObserver-driven mounts run in a microtask after the restore, and `warnOnce`'s `seen` set is module-wide and never reset (`warn.ts:1-6`) so a second case sharing a behavior name cannot re-emit. `harness.ts:58` swallows a missing job file. The empty-list keyed-list case (`keyed-list.test.ts:27-35`) does not assert `after === before`.

- [ ] `warn.ts`: add `export function __resetWarnOnce(): void { seen.clear() }` with a comment `test-only; the harness calls it between cases`. No other runtime change.
- [ ] `harness.ts`:
  - Capture both `console.warn` and `console.error` into the same `warnings` array (prefix entries `warn:` / `error:`).
  - Keep the capture installed from before chunk import until `unmount()`; `load()` returns the live array (the `Mounted.warnings` reference keeps growing during interactions). `unmount()` restores both console methods and calls `__resetWarnOnce()`.
  - After `mount()`, `await new Promise<void>((r) => queueMicrotask(r))` twice before snapshotting `after`, so MutationObserver callbacks (happy-dom queues them with `queueMicrotask`) have run.
  - Replace the `try { readFileSync(job) } catch {}` at `harness.ts:58` with an explicit decision: list `<dir>/*.server.ts`; if the compiler emitted a server file for the root, run the job; if it emitted none, `hasJob = false`. Never guess from `rootId` alone, and never swallow a read error.
  - Fix the comment at `harness.ts:6-7`: the chunks are emitted with `--runtime-import` pointing at a `.ts` path and fixtures import `./money` without an extension, so they do NOT run unchanged in Chromium. State what would be needed (a bundling step) instead of claiming it.
- [ ] Every case file: assert `m.warnings` equals `[]` once at the end of the test (after the last interaction) in addition to the existing assertion after `load`. `keyed-list.test.ts` empty-list case: add `expect(m.after).toBe(m.before)`.
- [ ] Negative control, kept as a test: `tests/browser/cases/harness-self-test.test.ts` mounts `theme-toggle`, then calls `console.error('[brust] probe')` and `warnOnce('probe', 'probe')` from inside the test after mount, and asserts both appear in `m.warnings`. Then a second `load` of the same fixture must be able to emit `warnOnce('probe', …)` again (proves the reset). Add this file to `BROWSER_CASES` too (so the count becomes 9 files) — or, if you prefer to keep `BROWSER_CASES` meaning "spec examples", change the exit test to assert `across ${BROWSER_CASES.length + 1} files` with a comment; either is acceptable, say which in the commit body.
- [ ] `bun run browser-test` green; `cd packages/runtime-dom && bun test` still `44 pass` (or more if you added a warn test).

Commit `test(browser): capture console.error and post-mount warnings, reset warnOnce per case, fail on missing job file`.

---

### Task 6: Computed exit report, lead report section, ledger rows

**Files:** `scripts/battery/exit.ts`, `docs/plans/m1-exit-report.md` (regenerated), `docs/react-coverage.md` (regenerated), `docs/plans/2026-10-09-m1-lead-report.md`, `docs/plans/m1a-followups.md`

- [ ] `exit.ts` `renderExitReport`: derive the "§12 reading" paragraph from data: the known-gap row ids and their ledger ids come from `KNOWN_GAP_ROWS`; the error-row sentence prints `ERROR_ROWS.length` and the word `refused` only when every one has `build === 'refused'` (otherwise it prints the failing ids — which Task 2's test already makes impossible, but the report must not hard-code the claim). Remove the hard-coded "`Error` rows carry an `Error` diagnostic" sentence. Add a "Build" line under "Battery": `N rows lowered with --emit all: N ok, N refused (error rows), N failed`.
- [ ] Make the per-category counts in the exit report separate `compile-error` from `error` the way `docs/react-coverage.md` does (today `exit.ts:34` merges them; E shows "5 error" while the coverage summary says 4 + 1).
- [ ] Add a "Verification" section to the exit report listing exactly what each gate checks, generated from the pinned constants (browser cases by name, `NO_SAMPLES`/`NO_DIRECTIVES` are Rust-side so list them by hand with a `// keep in sync with dual_eval.rs` comment in `exit.ts`).
- [ ] `docs/plans/2026-10-09-m1-lead-report.md`: append a section `## Scrutiny 2026-10-09` with: the six findings in one line each (battery `--emit ir` only; free-text known-gap; dual-eval silent skips and position-only x-for; keyed-list child props untested; harness warning capture scope; hard-coded report prose), the lead's manual `--emit all` sweep result (57 ok / 4 refused / 0 failed on @720e6d7), and "closed by `m1-gate-hardening` @<sha>" (fill the sha at PR time).
- [ ] `docs/plans/m1a-followups.md`: add ledger rows for what this lane deliberately does NOT fix, owner M2:
  - **F43** `crates/brust-compiler/tests/harness/eval.ts` mirrors runtime-dom's directive resolution instead of calling it (calls any function member where the runtime calls only signals; fake `effect`; `members.init` never called); replace with a happy-dom run of the real runtime.
  - **F44** dual eval never compares `x-show`, nor a child host's server `x-props` against the client `x-props-bind` value (`eval.ts:98-102` overwrites one with the other).
  - **F45** happy-dom cannot see an `x-model` / `x-bind-value` first-paint mismatch (setting `input.value` does not change the attribute; `visible()` compares innerHTML) nor foster-parenting (F32); a Chromium run (Playwright) is the only way to see them.
  - **F46** browser cases use selector-based negative assertions that pass trivially on a markup change (`truthiness.test.ts:11,18`, `controlled-input.test.ts:10,16`); `parent-counter.test.ts:16` asserts only that two names differ.
  - **F47** `runBattery()` builds `brustc` twice per `bun test scripts/battery` (both test files call it) and resolves the binary from `CARGO_TARGET_DIR`/`target` only, so a global `build.target-dir` runs a stale binary.
- [ ] Regenerate, run `bun test scripts/battery` (expect: all green, the committed-report test green on the second run).

Commit `docs: computed M1 exit report, scrutiny section in the lead report, ledger F43–F47`.

---

## Verification (READY evidence, paste all in the task note)

```
bun run battery && bun run battery && git status --short docs/   # empty
bun test scripts/battery                                          # green, counts
bun run browser-test                                              # 10 pass across 9 files (or 9/8 + self-test per Task 5 choice)
cargo test --workspace --exclude bun_react_compiler               # green
cargo test -p brust-compiler --test dual_eval -- --nocapture      # paste the 'dual evaluation:' line
PATH=/usr/bin:/bin cargo test -p brust-compiler --test dual_eval  # FAILS with the bun message (paste first line)
cargo fmt --all -- --check && cargo clippy -p brust-compiler -p brust-compiler-cli -p brust-jinja --no-deps -- -D warnings
cd packages/runtime-dom && bun test
```
Then PR `lane/m1-gate-hardening` → `v2`, CI green on all three jobs, lane HEAD sha.

## Risk ledger

- **Task 4 premise.** The lead compiled the exact `input.tsx`/`Row.tsx` above on @720e6d7 and got tier native with `x-props-bind="_p1:t"`; the golden runner may name the id differently (`_p2`). Assert on the attribute's presence and the `:t` row binding, not on the number.
- **Task 5 microtask wait.** happy-dom's MutationObserver uses `queueMicrotask`; two awaited microtasks are enough on 20.x. If `after !== before` appears only in the nested-list case after this change, that is a real finding (observer-driven mount changed the DOM), not a timing bug: file it, do not loosen the wait.
- **Task 3 regex alignment.** The runtime's `for.ts` `SYNTAX` accepts `$` and spaces after commas; copying it may make previously skipped rows participate and surface a mismatch. That is the intended effect; a mismatch is a ledger row for M2 (do not patch the compiler here).
- **Task 2 job counts.** `jobs` becomes mandatory for native/static rows; use the regenerated report as the source of each value, never this plan.
- **Known trap:** `bun test` from the repo root loads `scripts/battery/*.test.ts` AND `tests/browser/**`; always run the three commands separately as CI does.

## Dispatch table (for the Coordinator)

| slug | plan tasks | tier | role | deps | review | acceptance (READY evidence) |
|---|---|---|---|---|---|---|
| `m1-gate-hardening` | 1–6 | standard | Implementer (Standard) | none (base `v2` @720e6d7) | complex | the Verification block above pasted verbatim with outputs; `docs/react-coverage.md` shows the `Build` column with 0 failed; `docs/plans/m1-exit-report.md` has the Build line and Verification section; PR → `v2` CI green (all jobs); lane HEAD sha. |

Review is `complex` because the diff changes what "green" means for every later lane; the reviewer must run the negative controls (Task 3 no-bun run, Task 5 self-test) themselves, not read them.
