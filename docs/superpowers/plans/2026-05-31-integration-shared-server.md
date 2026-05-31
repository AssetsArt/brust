# Integration shared-server speedup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Share one long-lived server across stateless integration tests to cut `tests/integration.test.ts` wall-clock (~60s → target ≤42s), keeping cache/action/mcp/config/SSE/WS/stream-abort tests isolated.

**Architecture:** Add file-scoped `beforeAll`/`afterAll` that boot/stop ONE shared server (reusing `startServer` internals, workers=1). Migrate only the tests that satisfy ALL of {stateless, read-only request/response, default-config, shutdown-not-the-point} and are NOT on the denylist. Isolated tests keep `startServer` + `stop` + exit assertion unchanged.

**Spec:** `docs/superpowers/specs/2026-05-31-integration-shared-server-design.md` (reviewed, READY TO PLAN)

**Tech stack:** Bun test, the existing `freePort`/`startServer`/`readPortLine` helpers.

---

## Task 1: Add shared-server infra (additive, no migration)

**File:** Modify `tests/integration.test.ts` (helpers region near `startServer`, ~line 20).

- [ ] **Step 1: Add `beforeAll`/`afterAll` + `sharedPort()`**

Add `beforeAll, afterAll` to the `bun:test` import (line 1: `import { test, expect, beforeAll, afterAll } from 'bun:test'`).

After `startServer` (~line 38), add:

```ts
// One server shared by all stateless, read-only, default-config tests (see
// docs/superpowers/specs/2026-05-31-integration-shared-server-design.md). Cuts
// ~N redundant boots. Stateful/special tests still use startServer() per test.
let shared: { port: number; proc: import('bun').Subprocess } | null = null

beforeAll(async () => {
  const port = await freePort()
  const proc = spawn({
    cmd: ['bun', 'run', 'tests/fixtures/app/index.ts'],
    env: { ...process.env, BRUST_PORT: String(port), BRUST_WORKERS: '1', RUST_LOG: 'brust=warn' },
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const readyPort = await readPortLine(proc.stdout)
  shared = { port: readyPort, proc }
})

afterAll(async () => {
  if (!shared) return
  shared.proc.kill('SIGINT')
  // Single place that asserts clean shutdown for the shared server.
  expect(await shared.proc.exited).toBe(0)
})

/** Port of the shared server. ONLY for stateless, read-only, default-config
 * tests. NEVER GET /cache-test (mutates a JS renderCount) or any cacheable
 * route via a non-`/_brust/page` path (would perturb the isolated cache-stats
 * test). Stateful/special/long-lived-conn tests must use startServer(). */
function sharedPort(): number {
  if (!shared) throw new Error('shared server not started')
  return shared.port
}
```

- [ ] **Step 2: Verify still green (no migration yet)**

Run: `cd /Users/detoro/code/brust && bun test tests/integration.test.ts`
Expected: 72 pass, 0 fail. (beforeAll boots an extra idle server; every test still uses its own `startServer`.) `bun run ci` clean.

- [ ] **Step 3: Commit**

```bash
git add tests/integration.test.ts
git commit -m "test(integration): add file-scoped shared server infra (no migration yet)"
```

---

## Task 2: Migrate shareable tests to the shared server

**File:** Modify `tests/integration.test.ts`.

**Classification — migrate a test to `sharedPort()` ONLY if ALL hold** (else leave it on `startServer` untouched):
1. Stateless — no cache write, no action side-effect, no global-counter mutation.
2. Read-only request→response — no SSE/WS/long-lived connection, no raw-socket byte protocol.
3. Default config — needs only workers=1 + default fixture (no toml, no alt worker count, no request-size-limit env).
4. Shutdown is not the test's purpose.

**KEEP ISOLATED (do NOT migrate) — by cluster:**
- Cache: `cache-test route … cache hit`, `cache stats reflects hits and misses`, `invalidate by path`, `invalidate all`, `invalidate rejects GET`, `405 on invalidate keeps keep-alive`.
- Action + MCP: every `action endpoint: *`, `action middleware: *`, `action-calling island page …`, `mcp: *`.
- Special config: `reads port and workers from brust.toml`, `serves rendered html via worker pool` (workers:4), `414 … MAX_REQUEST_BYTES`, `action … 413`.
- Long-lived / abort: all SSE tests, all WebSocket tests, `streaming: mid-stream disconnect`.
- **Denylist:** no shared test may `GET /cache-test` directly (nav `GET /_brust/page/cache-test` is fine).

- [ ] **Step 1: Migrate each qualifying test**

Recipe per shared test — transform:
```ts
test('<name>', async () => {
  const { port, stop } = await startServer({ workers: '1' })
  try {
    /* ...request(s) to http://127.0.0.1:${port}... asserts... */
  } finally {
    const exit = await stop()
    expect(exit).toBe(0)
  }
}, <timeout>)
```
into:
```ts
test('<name>', async () => {
  const port = sharedPort()
  /* ...same request(s) + asserts, UNCHANGED... */
})
```
(Drop the `try/finally`, the `stop()`, and `expect(exit).toBe(0)` — invariant 2. Keep the timeout only if the body genuinely needs >5s; most won't.) **Do not change any request path, header, or assertion.** If a test reads `proc` for anything other than `exited`, it does NOT qualify — leave it isolated.

Apply ONLY to tests passing all 4 rules (the render/routing/params/headers/404/errorBoundary-render/island-marker-on-`/`/island-chunk-GET/nav-GET/read-only-middleware probes — incl. `streaming: single-chunk regression` and `nested routes: flat route still renders`, which are plain `/`-render GETs).

- [ ] **Step 2: Verify all pass**

Run: `bun test tests/integration.test.ts` → 72 pass, 0 fail.
If ANY test now fails (e.g. an order-dependent assertion you mis-shared), MOVE THAT TEST BACK to `startServer` (correctness over speed) and re-run. Do not weaken an assertion to make sharing work.

- [ ] **Step 3: Confirm non-flaky (5×) + measure**

Run `bun test tests/integration.test.ts` **5 times**; record each `Ran 72 tests … [Xms]`. ALL must be 0 fail. Report before (~60s) vs the 5 after-times.

- [ ] **Step 4: biome + commit**

```bash
bun run check:fix && bun run ci
git add tests/integration.test.ts
git commit -m "test(integration): share one server across stateless probes (~Nx fewer boots)"
```

**BLOCKED fallback:** if migrating a test introduces flake that isn't obviously stateful, ISOLATE it (revert that one test) rather than debugging — the win is incremental, any single test staying isolated is acceptable. Report which tests you ended up keeping isolated beyond the spec's list and why.

---

## Self-review

**Spec coverage:** shared infra (Task 1) ✅; classification rules + denylist + named-isolated (Task 2 Step 1) ✅; 72-pass + 5×-non-flaky + wall-clock (Task 2 Steps 2-3) ✅; invariant-2 exit-drop (Task 2 recipe) ✅; acceptance ≥30% (Step 3 measurement) ✅.
**Placeholders:** none — `<name>`/`<timeout>` are per-site substitutions in a transform recipe, not gaps.
**Type consistency:** `shared: {port, proc} | null`; `sharedPort(): number`; helper names match the existing `freePort`/`startServer`/`readPortLine`.
**Report requirement:** the implementer MUST report the final shared-vs-isolated test list (names) for orchestrator review — the classification is the load-bearing artifact.
