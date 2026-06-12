# Cross-process cache invalidation (cache sync) — design

**Date:** 2026-06-13
**Status:** draft
**Driver:** ketshopweb-engine R9 — `cache.invalidate({tags})` is in-process; another process (studio publishing) cannot invalidate the engine's caches. Target: "publish takes effect < 2s" deterministically via a pub/sub channel in DragonflyDB/Redis.

## Goal

When configured with a Redis-protocol URL (Redis or DragonflyDB — same wire protocol), every `cache.invalidate(args)` call **also publishes** the invalidation to a shared channel, and every brust process subscribed to that channel **applies it locally**. Any process (including a non-brust publisher like studio) can publish to the channel and invalidate all subscribed brust instances.

Verified empirically: Bun 1.4.0 `RedisClient` supports `subscribe(channel, cb)` + `publish(channel, message)` natively — **zero Rust changes, zero new dependencies**.

## Non-goals

- Shared/distributed cache storage (caches stay in-process moka; only *invalidation* propagates).
- Guaranteed delivery. Redis pub/sub is fire-and-forget; a process that is down during publish misses the message. Caches still have TTLs as backstop — same model as every pub/sub invalidation bus.
- Synchronous cross-process semantics. Local invalidation is synchronous; remote is eventual (typically <10ms on a LAN).
- Dynamic template propagation (R1) — out of scope here.
- Auth schemes beyond what the URL carries (`redis://:pass@host:port/db`, `rediss://` TLS — whatever Bun's RedisClient supports).

## High-level architecture

New module `runtime/cache-sync.ts`, pure TS:

```
cache.invalidate(args)                       subscriber (every brust process)
  ├─ local NAPI fan-out (unchanged, always)    └─ on message:
  └─ publishCacheSync(args)  ──► redis channel ──►  parse + validate JSON
     (fire-and-forget, only                         skip if sender === own token
      when sync configured)                         apply via local NAPI fan-out
                                                    (NOT cache.invalidate — no re-publish loop)
```

### Process/isolate model

One brust **process** = main isolate + N worker isolates (Bun Workers, same OS process). Rust caches are process-global; module state is per-isolate.

- **Subscriber:** main isolate only (guard: `process.env.BRUST_WORKER_ID === undefined`). One subscription per process. Applying an invalidation via NAPI from the main isolate reaches the process-global Rust caches — workers see it implicitly.
  - **Callback signature (verified empirically, Bun 1.4.0):** `subscribe(channel, (message: string, channel: string) => void)` — the callback receives `(message, channel)`, NOT `(err, message)`. Connection errors surface via the client's `onclose`, never through the subscribe callback.
  - **Boot-time unreachable redis (verified empirically):** `subscribe()` against a down host returns a promise that NEVER settles and `onclose` does NOT fire — a naive implementation silently disables the feature. The implementation MUST race the connect/subscribe against a timeout (e.g. 5s): on timeout, `close()` the client (best-effort), log a redacted warn, and schedule the backoff retry. This is what makes invariants 3/5 actually hold.
  - **Reconnect (verified empirically):** no auto-resubscribe after a drop. The `onclose` handler re-creates the client and re-subscribes via the same backoff loop.
- **Publisher:** lazy, per-isolate (workers call `cache.invalidate` from loaders/actions). Each isolate creates its own `RedisClient` on first publish.
- **Configuration handoff to workers:** main resolves config during `run()` (after `loadConfig`) and sets `process.env.BRUST_CACHE_SYNC_URL` / `_CHANNEL` / `_SENDER` **before** `serve()` spawns workers; `baseEnv = { ...process.env, ... }` (runtime/index.ts:184) carries them into every worker. Workers read env lazily at first publish.
- **Self-skip:** main generates a per-process sender token (`crypto.randomUUID()`) into `BRUST_CACHE_SYNC_SENDER`; all isolates of the process share it via env. The subscriber drops messages whose `sender` equals its own token (the publishing isolate already applied locally). Without the skip it would be a harmless idempotent double-apply; the skip avoids the wasted work.

### Message format (versioned)

```json
{ "v": 1, "sender": "<uuid>", "key": "...", "tags": ["..."], "path": "...", "method": "GET" }
```

All invalidation fields optional (mirrors `InvalidateArgs`). Unknown `v` or unparseable JSON → log one warn, drop. External publishers (studio) construct this JSON themselves — `sender` may be omitted (never matches, always applied). Document the shape in the docs page as the **public contract**.

## API surface

### Config (`runtime/config.ts`)

`brust.toml`:
```toml
[cache]
sync_url = "redis://127.0.0.1:6379"     # enables the feature; absent = current behavior
sync_channel = "brust:cache:invalidate" # optional, this default
```
Env overrides (win over TOML, standard precedence): `BRUST_CACHE_SYNC_URL`, `BRUST_CACHE_SYNC_CHANNEL`.

Three changes in `config.ts` that must land TOGETHER (omitting any one breaks precedence silently):
1. `BrustConfig` interface: `cacheSyncUrl?: string`, `cacheSyncChannel?: string`
2. TOML extraction (`[cache]` block, next to `max_entries`): `sync_url` → `cacheSyncUrl`, `sync_channel` → `cacheSyncChannel`
3. `extractFromEnv`: `BRUST_CACHE_SYNC_URL` → `cacheSyncUrl`, `BRUST_CACHE_SYNC_CHANNEL` → `cacheSyncChannel` (env wins over TOML, same as the other keys)
…and `run()` must destructure the new fields from `loadConfig`'s return value (they configure `startCacheSync`); the `process.env` writes are a separate side-effect for worker propagation.

### `runtime/cache-sync.ts`

```ts
export interface CacheSyncMessage { v: 1; sender?: string; key?: string; tags?: string[]; path?: string; method?: string }

/** Main isolate, called from run(): set env for workers, start the subscriber.
 * Idempotent. Never throws — a down redis logs a warn and retries in the
 * background (the server must boot regardless). */
export function startCacheSync(opts: { url: string; channel?: string }): void

/** Any isolate: publish an invalidation. No-op when sync is not configured
 * (env absent). Fire-and-forget — failures log (throttled) and never
 * propagate to the caller. */
export function publishCacheSync(args: InvalidateArgs): void

/** Apply a parsed message to the local NAPI caches (exported for tests). */
export function applyCacheSyncMessage(msg: CacheSyncMessage): void

/** Test/shutdown hook: close clients, stop reconnect timers. */
export function stopCacheSync(): void
```

### `runtime/cache.ts`

`cache.invalidate(args)` gains one line after the local fan-out: `publishCacheSync(args)` (static import; the module is tiny and dependency-free until configured).

### Boot wiring (`runtime/index.ts`, main-isolate branch of `run()`)

After `loadConfig`: when `cacheSyncUrl` present → set the three env vars (URL, channel, sender uuid) then `startCacheSync({ url, channel })`. Workers never call `startCacheSync` (env guard makes it a no-op if they do).

## Behavior invariants

1. Local invalidation NEVER depends on redis state: fan-out to NAPI happens first, unconditionally; publish failures are logged (throttled to once per 30s per error kind) and swallowed.
2. Received messages apply via direct NAPI calls (`islandCacheInvalidate`, `pageCacheInvalidate`, `responseCacheInvalidate`) — never via `cache.invalidate` — so a message can never re-publish (no loop, even across misconfigured channels).
3. Subscriber outage: on close/error, retry with capped exponential backoff (1s → 30s max), forever, with a throttled warn. Messages published while disconnected are lost (documented; TTL backstop).
4. `invalidate({})` stays a no-op locally AND is not published. Publish-side emptiness check: `!key && (!tags || tags.length === 0) && !path` — an explicit empty `tags: []` counts as empty.
5. Boot is never blocked: `startCacheSync` connects in the background **with a connect timeout** (the never-settling-promise trap above); a down redis at boot = redacted warn + retry loop.
6. Zero behavior change when not configured (no env, no toml key): no redis client is ever constructed.
7. **Log redaction:** the redis URL may carry credentials (`redis://:pass@host`). Every log line derived from it must print only `host:port` (via `new URL(url)`) — never the raw URL. (The env-var exposure itself is standard secret-in-env operator territory; documented.)
8. `stopCacheSync()` is wired into the graceful-drain path (`gracefulExit` in index.ts) so backoff timers can't fire between drain and exit; it also serves tests.
9. Connection-count note (documented): each worker isolate lazily holds one publisher connection → a process can hold up to `workers + 1` redis connections. Negligible for publish-time invalidation volume.

## File structure

- `runtime/cache-sync.ts` — new
- `runtime/cache.ts` — +1 import, +1 line in invalidate
- `runtime/config.ts` — `[cache] sync_url`/`sync_channel` parse + env overrides
- `runtime/index.ts` — boot wiring in the `!isWorker` branch
- `runtime/cache-sync.test.ts` — new
- `tests/cache-sync.integration.test.ts` — new, **skips when no local redis**
- `example/docs/content/` — extend the caching docs page with a "Cross-process invalidation" section (config + message contract for external publishers)

## Tests

Unit (`runtime/cache-sync.test.ts`, real addon for NAPI calls, no redis needed):
- `applyCacheSyncMessage` evicts a seeded island/page-cache entry by tag and by key (seed via NAPI set, apply message, assert gone)
- malformed message (bad JSON handled at subscriber; here: wrong `v` e.g. `v: 2`, non-array tags) → dropped, no throw
- self-skip: message with sender === own token does not evict (seed, apply, still present)
- `publishCacheSync` with no config → no-op, no throw
- `invalidate({})` not published (spy point: exported internal `_lastPublished` or inject transport — keep a small injectable seam `__setTransportForTest(t)`)

Integration (`tests/cache-sync.integration.test.ts`): `test.skipIf(!redisAvailable)` — `skipIf` evaluates at collection time, so the PING probe must complete BEFORE it: use a **top-level `await`** on a short-timeout probe (`Promise.race([client.connect()+ping, 1s timeout])`) at module scope:
- two RedisClients simulating two processes: process A = startCacheSync subscriber; external publisher publishes a tags message → seeded NAPI cache entry evicted within 1s (poll)
- publisher side: `cache.invalidate({tags})` with sync env set → message observed on the channel by a raw subscriber, correct shape, sender matches env token

## Acceptance criteria

- All new tests green locally (with redis) and green in CI (integration skips cleanly — CI has no redis service; assert the skip path doesn't error).
- Full `bun test` + `bun run ci` green; no Rust changes (`cargo` untouched).
- Docs section published with the message contract.

## Known limitations

- Fire-and-forget delivery (Redis pub/sub semantics) — TTLs are the backstop; consumers needing stronger guarantees can re-publish after reconnect on their side.
- The subscriber lives in the main isolate; if Bun ever moves Workers out-of-process this needs revisiting (currently same-process by design).
- One channel per process (no per-tag channels) — message volume for this use-case is publish-time only, negligible.

## Open questions resolved at plan-time

- ~~Bun RedisClient reconnect semantics~~ — RESOLVED at spec review (empirical): no auto-resubscribe; no `onclose` on boot-time unreachable host; subscribe promise never settles against a down host. Backoff loop re-creates the client + re-subscribes; connect raced against a timeout.
