# Brust dev hot-reload reliability implementation plan

owner: 0ddb11d0-954b-4710-90ce-8191a46fe3c3 (Aoki) · authority: in-loop

## Goal

Make `brust dev` reject invalid changed modules before destructive worker churn, process every watched edit that arrives during a rebuild, and keep error pages connected to the dev channel so a correcting edit recovers automatically. This contains the confirmed failures without claiming a full atomic worker-generation redesign.

This plan is based on executable diagnosis, not code inspection alone:

- `docs/superpowers/reports/2026-07-19-hot-reload-repro.md`
- `docs/superpowers/reports/2026-07-19-hot-reload-server-trace.md`
- `docs/superpowers/reports/2026-07-19-hot-reload-client-review.md`
- `docs/superpowers/reports/2026-07-19-hot-reload-syntax-crash-diagnosis.md`
- `docs/superpowers/reports/2026-07-19-hot-reload-island-staleness-diagnosis.md`

## Settled decisions

1. **Confirmed invalid-source failures are gated before live-generation mutation.** Syntax validation happens before cache/artifact/native-pool/worker changes. A validation failure broadcasts `error` and leaves the current workers serving. Full atomicity for later artifact/spawn failures is explicitly deferred.
2. **No watched event may be represented by a single dominant kind.** A debounce window may contain TS, app CSS, and component CSS together; all distinct kinds must reach the coordinator. Same-kind paths may be coalesced.
3. **The coordinator uses a bounded per-build-domain pending queue, not an unbounded event log.** Map `islands`/`ts`/`md`/`html` into one `full` domain because they execute the same branch; keep separate `app-css` and `component-css` domains. While a build is active, union paths within those three domains and drain `full`, then `app-css`, then `component-css`, until empty. This avoids both lost work and redundant full restarts while bounding memory during editor save storms.
4. **Changed JS/TS syntax is preflighted in the main isolate.** Use `Bun.Transpiler` with the loader selected from `.ts`, `.tsx`, `.js`, or `.jsx`; validate every existing changed module before `clearIslandCache`, artifact rebuilds, native-pool reset, or worker termination. This is syntax containment, not TypeScript type-checking.
5. **`BRUST_WORKERS=1` is mitigation only.** It reduced the observed native crash but still emitted false `reload → ok` for invalid source; it is not the fix.
6. **Do not change island build/cache production code.** Marty traced the apparent clean-copy RED to an invalid comment-only test mutation: `replace('{label}: {n}', ...)` changed the explanatory comment, which Bun correctly strips, rather than the rendered JSX node. Three comment-only runs kept emitted/served hashes identical, while a semantic JSX edit changed both hashes and carried the marker. The characterization must target rendered JSX and remain green; no island production fix is authorized.
7. **Reconnect catch-up, worker-ready timeout semantics, and in-page `building` UI are deferred.** They are inferred risks/UX gaps, not confirmed causes of this incident.

Rejected alternatives:

- Dropping edits while `state === 'building'`: confirmed user-visible loss, 5/5.
- Debouncing to one dominant kind: loses other build products in mixed save windows.
- Terminating the old pool and then seeing whether new workers import: the observed native fault occurs in that destructive interval.
- Immediately redesigning worker generations or changing island cache keys: larger changes without evidence that they are required.

## Global constraints

- Test first: every confirmed defect gets a red regression at the real seam before production changes.
- Disposable fixtures must be copied under `tests/fixtures/` at the same depth as `app`, use a dynamically allocated localhost port, and be removed in `afterEach` even after child-process failure.
- Do not mutate committed `tests/fixtures/app` in place; parallel test files share the checkout.
- A WebSocket frame is not freshness proof. After `reload`/`css-update`, assert the served route, CSS, or emitted/served island chunk contains the new marker.
- Never reset the native worker pool, terminate workers, or clear live caches after validation has failed.
- Preserve production behavior outside dev mode.
- Do not add persistent debug logging. Any temporary probe uses a unique `[DEBUG-...]` prefix and is removed before commit.

## Task 1 — Build the process-level regression harness

**Files**

- Add `tests/helpers/hot-reload-harness.ts`
- Add `tests/dev-hot-reload-reliability.test.ts`

**Harness interface**

Provide helpers that:

- create a fresh same-depth copy of `tests/fixtures/app` with no `.brust`;
- reserve a free localhost port;
- spawn `bun runtime/cli/index.ts dev <fixture>/index.ts` with `BRUST_NO_TUI=1` and a caller-selected `BRUST_WORKERS`;
- wait for `/ping`, collect stdout/stderr, and keep one `/_brust/dev` WebSocket open;
- await an ordered terminal message sequence with a bounded timeout;
- write/restore fixture files and always kill the child plus delete the fixture.

**Red/characterization cases**

1. Invalid `routes.tsx`, `BRUST_WORKERS=2` or greater:
   - expect `building → error`;
   - forbid `reload` and `ok` for that cycle;
   - `/ping` and the prior route remain healthy;
   - restoring valid source yields `building → reload → ok` and fresh route output.
2. In-flight edit:
   - edit page TSX;
   - upon its `building`, append a unique `app.css` marker;
   - require both cycles to finish and served `/_brust/css/app.css` to contain the marker.
3. Same-debounce mixed edit:
   - write TSX, `app.css`, and a CSS module inside one debounce window;
   - require all relevant build products to become fresh; no kind may disappear.
4. Fresh visible page output:
   - mutate a real route dependency, await reload, fetch the route, and assert the marker.
5. Island characterization:
   - mutate `components/Counter.tsx`, await reload/ok, then assert both the on-disk and HTTP-served `Counter_*.js` contain the marker;
   - target the rendered JSX text node with a unique semantic match; do not use a first-occurrence replacement that can hit the fixture comment header;
   - require the semantic edit to change both emitted and HTTP-served bytes. Comment-only edits may legitimately compile to identical output.

Commit the harness separately so later fixes can demonstrate red-to-green history.

## Task 2 — Preserve every watcher event and drain queued work

**Files**

- `runtime/dev/watcher.ts`
- `runtime/dev/watcher.test.ts`
- `runtime/dev/coordinator.ts`
- `runtime/dev/coordinator.test.ts`

**Watcher change**

Replace dominant-kind collapse with grouping by kind. During a debounce flush:

- classify each retained path;
- group paths into `Map<ChangeKind, Set<string>>`;
- invoke `onChange` once for each non-empty kind in priority order:
  `islands`, `ts`, `md`, `html`, `css`, `component-css`.

Update the watcher contract comment: priority orders delivery; it does not discard lower-priority kinds.

**Coordinator change**

Replace the early-return single-flight guard with:

- `pending: Map<'full' | 'app-css' | 'component-css', Set<string>>`;
- one `drainPromise`/drain owner;
- `handleChange(ev)` maps the event kind to its build domain, merges paths into that domain, starts the drain if idle, and otherwise returns the active drain promise;
- the drain repeatedly removes the highest-priority pending kind and runs one existing build cycle;
- events arriving during any `await` merge into the pending map and are processed before the drain resolves;
- one cycle's caught error does not discard later pending kinds.

Keep `building` and exactly one terminal outcome (`reload`/`css-update` followed by `ok`, or `error`) per drained batch.

**Unit tests**

- replace `single-flight: change-while-building is dropped` with a queued-replay assertion;
- same-domain events merge/dedupe paths and cause one replay;
- the four full-reload kinds coalesce into one full cycle, while app CSS and component CSS still execute independently in priority order;
- an error in the first batch still allows the pending second batch to run;
- watcher mixed debounce emits every distinct kind;
- ignored/test/generated paths remain ignored.

Task 1 in-flight and mixed-edit cases must turn green.

## Task 3 — Reject invalid changed modules before live mutation

**Files**

- Add `runtime/dev/validate-change.ts`
- Add `runtime/dev/validate-change.test.ts`
- `runtime/dev/coordinator.ts`
- `runtime/dev/coordinator.test.ts`
- `runtime/index.ts`

**Interface**

```ts
export async function validateChangedModules(paths: string[]): Promise<void>
```

Behavior:

- accept `.ts`, `.tsx`, `.js`, and `.jsx`; skip other extensions and paths that no longer exist;
- read each file and run `Bun.Transpiler.transformSync` with its matching loader and target `bun`;
- collect parse diagnostics and throw one `Error` naming every invalid file; do not resolve imports or type-check;
- return without side effects for valid/deleted/non-module paths.

Add `validateChanges(paths)` to `CoordinatorDeps`. For the shared `ts/html/islands/md` branch, call it first, before `clearIslandCache`, `buildIslands`, `reEmitJinja`, native-pool reset, `terminateAll`, or `spawnAll`. Wire it from `runtime/index.ts` to `validateChangedModules`.

**Tests**

- valid TS/TSX/JS/JSX pass;
- invalid syntax returns a stable filename-bearing error;
- deleted paths and CSS/MD/HTML are skipped;
- validation rejection broadcasts `building → error` and calls none of the mutating/build/worker dependencies;
- valid modules retain the existing order `validate → buildIslands → reEmitJinja → terminate → spawn → reload → ok`.

Task 1 invalid/repair process test must turn green repeatedly without a process fault.

## Task 4 — Keep React error documents on the dev channel

**Files**

- `runtime/render/stream.ts`
- `runtime/render/stream.test.ts`

In `onShellError`:

- render the configured error boundary as today;
- if a dev snippet exists, inject it before `</head>` using `injectDevClient`;
- if the boundary returns a fragment/document without `</head>`, prepend the trusted internal dev snippet so the browser still executes it;
- send the resulting HTML as the 500 body.

If the error boundary itself throws:

- production keeps the existing plain-text `Internal Server Error` response;
- dev mode returns a minimal HTML 500 containing the generic message and dev snippet, without exposing the thrown error details.

Tests must set and reset `configureDevClientSnippet` explicitly and cover a full document, fragment boundary, boundary-throws dev fallback, and unchanged production fallback. A deterministic test must prove the error document contains the dev client and can receive the later recovery cycle.

## Task 5 — Integration and acceptance

Task 5 is an **integrator-only post-merge gate**. Individual lanes must not name files produced by another unmerged lane:

- Tasks 1–3 gate only their existing boundary files, and must assert every named test file exists before invoking Bun.
- Task 4 gates with `test -f runtime/render/stream.test.ts && bun test runtime/render/stream.test.ts runtime/render/inject-dev-client.test.ts`.
- After both lanes merge, the integrator asserts all newly added test files exist and then runs the commands below. This prevents Bun's missing-path behavior from producing a false green.

Run from a clean checkout with no disposable fixture directories:

```sh
test -f runtime/dev/validate-change.test.ts
test -f tests/dev-hot-reload-reliability.test.ts
bun test runtime/dev/watcher.test.ts runtime/dev/coordinator.test.ts runtime/dev/validate-change.test.ts runtime/render/stream.test.ts
bun test tests/dev-hot-reload-reliability.test.ts tests/dev-reload.test.ts tests/dev-reload-option.test.ts
bun test runtime/
bun test tests/integration.test.ts
bun run typecheck:treaty
bun run ci
```

Acceptance requires:

- invalid `routes.tsx` never kills the dev process and never emits false `reload`/`ok`;
- the last healthy generation continues serving during the error;
- correcting the file recovers without restarting `brust dev`;
- rapid and mixed-kind edits all become observable in served output;
- React error pages contain the dev client and recover on the next valid edit;
- the island characterization uses a semantic JSX edit and is green without an island production change;
- no disposable fixture, `[DEBUG-...]` log, or task-boundary leak remains.

## Task 6 — Diagnose confirmed island staleness in a separate lane

**File**

- `docs/superpowers/reports/2026-07-19-hot-reload-island-staleness-root-cause.md`

This task is evidence-only and must not edit production or test code. It must:

- reproduce the skipped `an island edit refreshes both the emitted and served client chunk` process case at least three times from a clean-copy fixture;
- trace the edit from watcher classification through the `runtime/index.ts` island map supplied to `buildIslands()` and through `runtime/islands/build.ts` output replacement;
- record source bytes, discovered island-map entry, Bun build input/output identity, emitted chunk path/hash, and HTTP-served path/hash before and after the edit;
- distinguish stale discovery/cache state from stale bundler input, output replacement, filename selection, and HTTP serving;
- state one falsifiable root cause and the smallest exact production/test boundary for a red-green fix, including focused and process-level gate commands.

The investigation found no production island defect: the prior RED edited a stripped comment. Repair the characterization inside `hot-reload-core-fix`; do not create an island implementation task or apply speculative cache-busting unless a future semantic edit reproduces stale emitted or served bytes.

## Risk ledger and deferred work

- **Bun native crash:** the exact stripped Bun caller below `_platform_memmove` is unknown. Preflight contains the confirmed trigger without claiming to repair Bun internals. Preserve the LLDB evidence in the diagnosis report for an optional upstream issue; publishing that issue requires separate authorization.
- **Validation coverage:** syntax preflight intentionally does not catch missing exports, type errors, or runtime exceptions. Those should flow through normal worker startup/error handling; do not turn dev reload into a full production bundle on every save.
- **Later-stage atomicity:** `buildIslands()` can replace its output directory and `reEmitJinja()` mutates the process-global template environment before worker replacement. This plan does not promise rollback if those later stages partially succeed and a subsequent spawn fails; establish a repro before designing atomic artifact/generation swaps.
- **Worker readiness timeout:** `spawnAll()` currently resolves after five seconds even without `brust-worker-ready`. Add a separate repro before changing this contract.
- **Reconnect catch-up:** a client disconnected during the one-shot reload frame may reconnect stale. First add a protocol test and decide whether a generation handshake is warranted.
- **Island false positive:** the apparent stale output was caused by a comment-only mutation that Bun strips. `hot-reload-island-root-cause` records the source/map/build/output/HTTP hashes and credits Marty for falsifying cache, filename, replacement, and serving defects. Keep the semantic JSX characterization green; do not infer freshness from source-marker absence when the edited syntax need not survive compilation.
- **Build progress UI:** ignoring `building` is a UX choice, not a correctness defect; defer.
