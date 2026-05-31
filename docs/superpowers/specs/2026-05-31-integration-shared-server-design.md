# Integration test speedup — shared server for stateless probes

**Status:** spec — draft (autonomous pipeline), awaiting subagent review
**Date:** 2026-05-31
**Branch:** `perf/integration-shared-server`

## Goal

`tests/integration.test.ts` spawns ONE fresh server per test (72 tests → 72
`bun run tests/fixtures/app/index.ts` boots, ~0.85s each → ~60s wall-clock). The
per-boot floor is bun process startup + `.node` addon load; `workers=1` already
shaves what it can. The only remaining lever is **reducing the number of boots**:
share ONE long-lived server across the tests that are stateless, read-only, and
need no special config — keep a dedicated server only where isolation is
load-bearing.

## Non-goals

- **Speeding up individual server boot.** Already at the bun+addon floor.
- **Sharing servers across the cache / action / mcp / config tests.** Those
  mutate server state or need special boot config — they stay isolated. This
  caps the achievable win (see Acceptance); it is NOT a 3–4× refactor.
- **Test parallelism / `test.concurrent`.** Many simultaneous servers + the
  freePort TOCTOU window = new flake surface. Out of scope.
- **Changing what any test asserts** (beyond dropping the incidental
  `expect(exit).toBe(0)` cleanup check on shared-server tests — see invariants).

## Design

A module-level shared server, started once and stopped once:

```ts
let shared: { port: number; proc: Subprocess } | null = null
beforeAll(async () => { shared = await bootShared() })   // workers=1, default fixture
afterAll(async () => { if (shared) { shared.proc.kill('SIGINT'); expect(await shared.proc.exited).toBe(0) } })
function sharedPort(): number { return shared!.port }
```

- `bootShared()` reuses the existing `startServer({ workers: '1' })` internals
  (freePort + spawn + `readPortLine` ready-wait) but does NOT return a `stop` the
  tests call — the server lives for the whole file; `afterAll` owns teardown and
  is the single place that asserts a clean (exit 0) shutdown.
- The existing `startServer(...)` helper is UNCHANGED and still used by every
  isolated test.

## Classification — the load-bearing decision

**Default to ISOLATED. A test joins the shared server only if ALL hold:**
1. **Stateless** — does not mutate persistent server state another test could observe (cache entries, cache hit/miss counters, action side-effects).
2. **Read-only request/response** — plain HTTP request → assert response. No long-lived connection (SSE/WS) pinning a worker, no raw-socket byte protocol.
3. **Default config** — needs only `workers=1` + the default fixture (no toml, no alternate worker count, no request-size-limit env).
4. **Shutdown is not the test's purpose** — it doesn't specifically assert clean exit / SIGINT behaviour.

**SHARED (candidate set — pure GET/HTTP probes):** root `/` render, `/ping`,
dynamic params, header/cookie/search echoes, 404, per-route errorBoundary
(render-only, no global mutation), island marker injection on `/`, island chunk
serving `GET /_brust/islands/*`, client-side nav `GET /_brust/page/*`, read-only
middleware verdicts. (~25–30 tests.)

**ISOLATED (keep `startServer` + own `stop` + exit assertion) — and WHY:**
- **Cache cluster** (`cache-test route … cache hit`, `cache stats reflects hits and misses`, `invalidate by path`, `invalidate all`, `invalidate rejects GET`, `405 keep-alive` regression): hit/miss counters and cache entries are **process-global** — a shared server pollutes counts with every other test's requests; ordering would make these non-deterministic. The `405 keep-alive` test also speaks raw socket bytes.
- **Action + MCP cluster** (`action endpoint: *`, `action middleware: *`, `mcp: tools/call createNote …`, form/multipart): `createNote` and friends **mutate in-memory state**; many also need specific request framing. MCP `tools/call` invokes actions (same mutation).
- **Special-config**: `reads port and workers from brust.toml` (asserts toml-driven port/workers — must control env), the multi-worker test (`workers: '4'`), `414 MAX_REQUEST_BYTES`, action `413` (request-size limits / raw socket).
- **Long-lived connections**: SSE and WebSocket tests — they hold a connection and (with `workers=1`) can occupy dispatch; isolate to avoid cross-test interference. (Conservative: isolate even though most would likely be safe.)
- **`streaming: mid-stream disconnect`** (integration.test.ts:~1594) — ISOLATED with a real (not just conservative) reason: it aborts a chunked stream and asserts the workers=1 worker recovers its `RenderSlotGuard`. A leaked slot on a *shared* server would corrupt every subsequent shared test. (The other streaming/`/`-render tests — `streaming: single-chunk regression`, `nested routes: flat route still renders` — are plain GET probes and CAN join the shared set.)
- **Shutdown-purpose**: any test whose assertion IS the clean-exit / signal behaviour.

> **Denylist — never request these from the shared server:** `GET /cache-test`
> (rendering `CacheTest` increments a JS-side module `renderCount`, a mutation
> even on an uncached hit) and any cacheable route via a *non*-nav path (a real
> cache write the isolated `cache stats` test would otherwise see). The nav probe
> `GET /_brust/page/cache-test` is safe — `server.rs` passes `cache_wanted:false`
> on the `/_brust/page/*` path, so it neither writes the cache nor bumps the
> hit/miss counters (verified in review).

**Out of scope:** the `/_test/native*` routes in the fixture (`routes.tsx`) have
**no tests in this file** — they don't factor into the shared/isolated split.

> **Rule when unsure: ISOLATE.** We just shipped a fix for a test-isolation
> flake ([[bun-mock-module-leaks-suite]] sibling: the close-after-405 race) —
> correctness over speed. A wrongly-shared stateful test reintroduces exactly
> that class of order-dependent flake.

## Invariants

1. **Shared-server tests never mutate shared state.** If a "shared" test is later found to write cache/action state, it MUST move to isolated. The classification is auditable per-test in the plan.
2. **Shared-server tests do not kill the server** and drop their `expect(exit).toBe(0)`. Clean-shutdown is asserted exactly once, in `afterAll`.
3. **`beforeAll`/`afterAll` are file-scoped.** The shared server idles while an isolated test runs its own (distinct freePort, no collision).
4. **No assertion changes** beyond invariant 2.

## Tests / verification

- `bun test tests/integration.test.ts` → all 72 pass.
- Run **5×** locally (memory: flaky-suspects 5×) → 0 fail each (this refactor's whole risk is isolation flake).
- Report before/after wall-clock.
- `bun run ci` (biome) clean; `cargo fmt --check` (no Rust change expected).
- CI (PR) green on macOS **and** Linux.

## Acceptance criteria

- All 72 integration tests pass, 5× non-flaky locally + green PR CI (macOS+Linux).
- Wall-clock materially reduced. **Realistic target ≥30% (≈60s → ≤42s)**; the
  stateful action/cache/mcp majority stays isolated, so this is NOT a 3–4× win —
  honest bound stated up front.
- Zero behaviour/coverage change (only shared-vs-isolated boot strategy + the
  invariant-2 exit-assertion drop).

## Known limitations / deferred

- SSE/WS/streaming tests stay isolated conservatively; a follow-up could share a
  dedicated streaming server if the win justifies the isolation analysis.
- The freePort TOCTOU window is unchanged (already shipped; sequential file
  execution keeps it negligible).

## Open questions resolved at plan time

1. **Does any "shared" candidate secretly mutate state?** The plan audits each
   migrated test; if a render path writes a cacheable entry that a later shared
   test's stats would see — but stats is isolated, so cache writes by shared
   tests don't affect any shared assertion. Confirmed safe.
2. **`beforeAll` boot failure** → `afterAll` guards `if (shared)`; a boot failure
   surfaces as the suite erroring at `beforeAll` (clear signal), not silent skips.
3. **Shared server dies mid-suite** (e.g. OOM) → `afterAll`'s
   `expect(await proc.exited).toBe(0)` would fail with a confusing signal. Low
   probability (no shared test crashes a worker — crash/errorBoundary tests are
   render-only, verified in review), accepted; the failure is loud, not silent.
