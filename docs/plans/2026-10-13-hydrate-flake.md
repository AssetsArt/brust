# L26 hydrate-flake: `brust-island[data-hydrated="1"]` never appears on CI (F122)

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · base: v2 @282335a · flow: lane → PR → CI → lead merges · ledger row: F122 (`docs/plans/m1a-followups.md`) · blackboard: `flakes:v2` entry #3

## Why

`tests/server/hydrate.chromium.test.ts` failed three times on CI during the gaps round, on two unrelated lanes, and never locally:

| Run | Lane | Head | Failing test |
|---|---|---|---|
| 38356365814 (first attempt) | `external-island` (L22) | 59b13b5 | `Team Full at six: the seventh button is disabled` |
| 38356365814 (rerun of the failed job) | `external-island` (L22) | 59b13b5 | `island Remove updates the native button without a reload` |
| 38359599228 | `gap-const-fold` (L1) | 8a293d0 | `island Remove updates the native button without a reload` |

Every failure is the same wait: `open()` in the test (line 32) does `page.waitForSelector('brust-island[data-hydrated="1"]', { timeout: 15_000 })` and times out. The implementer of L22 ran the file 7/7 green twice locally on 59b13b5 and on its merge with v2; the pokedex fixture has no package component, so L22 is inert there. The same job is green on v2 @ae79e3b, @ee11060 and @282335a. Both failing tests are the third and fourth `open('/pokemon/…')` of the file; the first two always pass.

The test records console errors and page errors into `errors` but only asserts them in `finish()`, which the timeout never reaches. So today a CI failure tells us nothing about *why* the island did not hydrate. That is the first thing this lane fixes.

## Rulings

- **R26.1 No blind timeout bump.** Raising the 15 s wait without a named cause is rejected at review. A longer wait is acceptable only as a consequence of a found cause (for example, a documented runner-load number), stated in the ledger row.
- **R26.2 The next failure must explain itself.** Whatever the root cause turns out to be, the test's wait is wrapped so a timeout reports: the console errors and warnings collected so far, every `requestfailed` and every non-2xx response under `/_brust/`, the `data-hydrated` state and `data-id` of every `brust-island` on the page, and whether the react runtime chunk loaded. This stays in the test after the fix.
- **R26.3 Fix at the source.** If the cause is in `packages/runtime-dom/src/island.ts` (scheduling via `whenIsland` / `idle` / `pending`), the server, or the build output, fix it there with a unit or integration test that reproduces the race deterministically. If the cause is the test harness (shared `browser` default context across tests, server reuse, the `raw.githubusercontent.com` route, leftover state from a previous page), fix the harness. A test-only fix must say in the ledger row why the runtime is not at fault.
- **R26.4 Evidence of green.** The PR's CI must be green on two separate runs of `ci.yml` on the final head (dispatch the second with `gh workflow run ci.yml --ref <branch>`); cite both run ids in the ledger row. If local reproduction succeeds under load, say how (command and what load).

## Where to look first (leads, not conclusions)

1. `packages/runtime-dom/src/island.ts` lines 53–66: `scheduleHost` adds the host to `pending`, then `whenIsland(id, …)` runs `idle(() => hydrateHost(...))`. Check what `idle` is on a headless Chromium under load (`requestIdleCallback` with no deadline can be starved while the page keeps painting; a hidden or throttled tab delays it further) and whether `whenIsland` can resolve before the host is observed.
2. The island chunk request: `/_brust/client/react-*`. Confirm on a failure whether the request was made, failed, or returned a stale hash after the fixture rebuild (`startPokedex` in `tests/server/harness.ts` builds once in `beforeAll`).
3. The test harness: one `chromium.launch()` and one `startPokedex()` for the whole file, pages created with `browser.newPage()` on the default context. Tests 3 and 4 run after tests 1 and 2 wrote to the team via native handlers and the API (`seed`). Check whether a page from an earlier test is still alive or still holding a route when the next page opens, and whether the server-side store state from earlier tests changes which islands the page renders.
4. Reproduce under load: run the file in a loop while something CPU-heavy runs (for example a `cargo build` of the workspace in another worktree, or `bun test` of the battery in parallel). CI runners are 2–4 vCPU; local Macs hide scheduling races.

## Acceptance

- Root cause named in one sentence in the F122 ledger row, with the file and line.
- The failing scenario is impossible after the fix, demonstrated by a test that failed before the fix (deterministic reproduction) or, if the race cannot be forced, by the diagnostic wrapper from R26.2 plus the two green runs from R26.4.
- `bun test --timeout 120000 tests/server/hydrate.chromium.test.ts` green locally after `cd packages/brust && bun run build:debug`.
- Ledger row F122 filled (Where / Finding / fix / state `DONE <date> — plan hydrate-flake (lane …)`, PR number). The lane touches no other ledger row.
- Blackboard `flakes:v2` entry #3 updated to point at the PR (the coordinator owns the key; post the PR number as a task note and it updates the entry).

## Boundary

`tests/server/hydrate.chromium.test.ts`, `tests/server/harness.ts`, `packages/runtime-dom/src/island.ts` and its tests, `packages/brust/src/**` only if the cause is there, `docs/plans/m1a-followups.md` (row F122 only).

## Task table

| slug | tier | role | deps | acceptance |
|---|---|---|---|---|
| `hydrate-flake` | standard | implementer (knock2, pre-briefed) | `external-island` merged | the Acceptance section above; review: standard |
