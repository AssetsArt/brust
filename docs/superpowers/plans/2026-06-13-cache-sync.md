# Cross-process cache invalidation — implementation plan

Spec: `docs/superpowers/specs/2026-06-13-cache-sync-design.md`
Branch: `feat/cache-sync`

## Task 1 — cache-sync module + cache.ts hook + config + unit tests (TDD)

### 1a. `runtime/config.ts`

Three changes together: `BrustConfig` gains `cacheSyncUrl?: string` + `cacheSyncChannel?: string`; `[cache]` TOML block parses `sync_url`/`sync_channel` (string fields, next to `max_entries` — follow the existing string-extraction style used by `[server] address`); `extractFromEnv` reads `BRUST_CACHE_SYNC_URL`/`BRUST_CACHE_SYNC_CHANNEL` (env wins, same as other keys). Extend the existing config tests (find `config.test.ts`) with: TOML round-trip, env override, absent → undefined.

### 1b. `runtime/cache-sync.ts` (new)

```ts
// R9 cross-process cache invalidation. Publishes cache.invalidate() calls to a
// redis/dragonfly pub/sub channel and applies messages from peers to the local
// process-global Rust caches. Pure TS — Bun's native RedisClient, zero deps.
//
// Bun 1.4.0 RedisClient facts (verified empirically — do not "simplify"):
// - subscribe(channel, cb): cb receives (message, channel). Errors do NOT come
//   through the callback; disconnects fire client.onclose.
// - Against an unreachable host, connect()/subscribe() return promises that
//   NEVER settle and onclose never fires → every connect must be raced
//   against a timeout or a down redis silently disables the feature.
// - No auto-resubscribe after a drop → onclose re-creates the client.
import * as native from './index.js'
import type { InvalidateArgs } from './cache.ts'

export interface CacheSyncMessage {
  v: 1
  sender?: string
  key?: string
  tags?: string[]
  path?: string
  method?: string
}

const CHANNEL_DEFAULT = 'brust:cache:invalidate'
const CONNECT_TIMEOUT_MS = 5_000
const BACKOFF_BASE_MS = 1_000
const BACKOFF_MAX_MS = 30_000
const WARN_THROTTLE_MS = 30_000
```

State: module-local `let` slots — subscriber client, publisher client (lazy), retry timer, stopped flag, lastWarnAt per kind. Transport seam for tests:

```ts
export interface CacheSyncTransport {
  publish(channel: string, message: string): Promise<unknown>
}
let testTransport: CacheSyncTransport | null = null
export function __setTransportForTest(t: CacheSyncTransport | null): void { testTransport = t }
```

Functions (signatures per spec):

- `redactUrl(url: string): string` — `new URL(url)` → `${hostname}:${port}`; on parse failure return `'<unparseable redis url>'`. EVERY log line uses this.
- `warnThrottled(kind: string, msg: string)` — once per 30s per kind via a Map<string, number>.
- `applyCacheSyncMessage(msg: CacheSyncMessage): void` — validate (`msg.v === 1`; tags if present must be `Array.isArray` of strings — else warnThrottled + return); skip if `msg.sender && msg.sender === process.env.BRUST_CACHE_SYNC_SENDER`; then EXACTLY mirror cache.ts local fan-out:
  ```ts
  ;(native as any).islandCacheInvalidate?.(msg.key, msg.tags)
  ;(native as any).pageCacheInvalidate?.(msg.key, msg.tags)
  ;(native as any).responseCacheInvalidate?.(msg.tags, msg.path, msg.method)
  ```
- `publishCacheSync(args: InvalidateArgs): void` — emptiness guard (`!args.key && (!args.tags || args.tags.length === 0) && !args.path` → return); config from env (`BRUST_CACHE_SYNC_URL` absent → return); build `CacheSyncMessage` with `sender: process.env.BRUST_CACHE_SYNC_SENDER`; if `testTransport` use it, else lazily create the publisher RedisClient; `.publish(channel, JSON.stringify(msg))` with `.catch(e => warnThrottled('publish', ...))`. Synchronous fire-and-forget from the caller's view (no await in cache.invalidate).
- `startCacheSync(opts: { url: string; channel?: string }): void` — main-isolate only is the CALLER's concern (run() wires it); function itself is idempotent (started flag). Async connect loop:
  ```
  attempt(): create RedisClient(url); race [client.connect?.() then subscribe(channel, onMessage)] vs timeout(CONNECT_TIMEOUT_MS)
    - on success: attach client.onclose = () => scheduleRetry(); reset backoff
    - on timeout/error: try client.close() (best-effort, swallow), warnThrottled('connect', `cache-sync: redis unreachable at ${redactUrl(url)}, retrying`), scheduleRetry()
  scheduleRetry(): if stopped → return; setTimeout(attempt, backoff); backoff = min(backoff*2, BACKOFF_MAX_MS)
  ```
  `onMessage(message: string, _channel: string)`: try JSON.parse → applyCacheSyncMessage; on parse error warnThrottled('parse', ...).
  NOTE: verify empirically whether `RedisClient` needs explicit `.connect()` before `.subscribe()` or whether subscribe auto-connects (the round-trip probe earlier used bare subscribe successfully — bare subscribe is fine; race THE SUBSCRIBE promise against the timeout).
- `stopCacheSync(): void` — stopped flag, clearTimeout, close both clients best-effort, reset state (so tests can restart).

### 1c. `runtime/cache.ts`

```ts
import { publishCacheSync } from './cache-sync.ts'
// ... inside invalidate(args), after the three NAPI lines:
    // R9: propagate to peer processes when cache-sync is configured (no-op
    // otherwise). Fire-and-forget — local invalidation never depends on redis.
    publishCacheSync(args)
```
Export `InvalidateArgs` already exists — cache-sync imports the type.

### 1d. `runtime/cache-sync.test.ts` (new, real addon, no redis)

- seed island cache via `(native as any).islandCacheSet('cs-test-1', ['cs-tag-a'], null/undefined ttl, '<p>x</p>', '{}')` — READ runtime/cache.test.ts first and reuse its exact seeding helpers/arg shapes; then `applyCacheSyncMessage({v:1, tags:['cs-tag-a']})` → `islandCacheGet('cs-test-1')` null.
- by key: same with `{v:1, key:'cs-test-2'}`.
- self-skip: set `process.env.BRUST_CACHE_SYNC_SENDER = 'tok'`, message `{v:1, sender:'tok', tags:[...]}` → entry SURVIVES; cleanup env in finally.
- wrong version `{v:2}` and `tags: 'not-array'` → no throw, entry survives.
- `publishCacheSync({})` and `{tags: []}` with `__setTransportForTest` spy → spy NOT called.
- `publishCacheSync({tags:['a']})` with env URL set + spy transport → spy called once, message parses to `{v:1, sender, tags:['a']}`.
- env URL absent → spy not called.

### 1e. Gates

`bun test runtime/cache-sync.test.ts runtime/cache.test.ts runtime/config.test.ts` green → `bun run ci` → commit `feat(runtime): cache-sync module — pub/sub cross-process invalidation (R9)`.

## Task 2 — boot wiring + graceful drain + integration test + docs

### 2a. `runtime/index.ts` (!isWorker branch of run(), right after the configureCache block ~line 436)

```ts
      const { cacheSyncUrl, cacheSyncChannel } = /* add to the loadConfig destructure */
      if (cacheSyncUrl) {
        // R9 cross-process invalidation. Env set BEFORE serve() spawns workers
        // (baseEnv = {...process.env}) so worker isolates can publish; the
        // subscriber lives here in the main isolate (NAPI caches are
        // process-global, workers see applied invalidations implicitly).
        process.env.BRUST_CACHE_SYNC_URL = cacheSyncUrl
        if (cacheSyncChannel) process.env.BRUST_CACHE_SYNC_CHANNEL = cacheSyncChannel
        process.env.BRUST_CACHE_SYNC_SENDER ??= crypto.randomUUID()
        const { startCacheSync } = await import('./cache-sync.ts')
        startCacheSync({ url: cacheSyncUrl, channel: cacheSyncChannel })
      }
```
And in `gracefulExit` (~line 208): best-effort `import('./cache-sync.ts').then(m => m.stopCacheSync()).catch(() => {})` before/parallel to beginDrain (do not delay exit).

### 2b. `tests/cache-sync.integration.test.ts` (new)

Top-level await probe:
```ts
const redisAvailable = await (async () => {
  try {
    const { RedisClient } = await import('bun')
    const c = new RedisClient('redis://127.0.0.1:6379')
    await Promise.race([
      c.send('PING', []),
      new Promise((_, rj) => setTimeout(() => rj(new Error('timeout')), 1000)),
    ])
    c.close()
    return true
  } catch { return false }
})()
```
(verify `send`/`ping` API shape empirically; whatever works in 1.4.0). Tests with `test.skipIf(!redisAvailable)`:
1. subscriber applies remote message: set env sender token; `startCacheSync({url})`; wait ~300ms for subscribe; seed island cache via NAPI; external RedisClient publishes `{v:1, sender:'other', tags:['it-tag']}`; poll up to 2s for entry eviction; `stopCacheSync()` + env cleanup in finally.
2. publisher emits on invalidate: raw RedisClient subscribes to the channel; set env URL+sender; `cache.invalidate({tags:['it-pub']})`; expect message within 2s with correct shape + sender === env token.
Use a UNIQUE channel per test run (`brust:cache:invalidate:test:${Date.now()}` — pass via env/opts) so parallel/stale runs don't cross-talk. Also assert the skip path: when redis is absent the file must still load cleanly (this is implicit — just don't crash at module scope).

### 2c. Docs

Extend the caching docs page (`example/docs/content/caching.md` — read it first): new "Cross-process invalidation" section — brust.toml keys, env overrides, the JSON message contract for external publishers (studio use-case: publish `{"v":1,"tags":["shop:42"]}` to the channel after saving), delivery semantics (fire-and-forget, TTL backstop), connection count note, credential redaction note.

### 2d. Gates

Full `bun test` (with local redis running AND once with `redis-server` stopped? — at minimum assert skip works by running the file with `BRUST_TEST_NO_REDIS=1`? Simpler: trust skipIf; CI has no redis and will exercise the skip path), `bun run ci`, commit `feat(runtime): cache-sync boot wiring + integration tests + docs (R9)`.

## BLOCKED fallbacks

- If `RedisClient.subscribe` requires connect-first in some path: call `await client.connect()` raced vs timeout, THEN subscribe (also raced).
- If Bun's RedisClient lacks a working PING (`send` API differs): probe with a plain `connect()` race instead.
- If the integration test is flaky on timing: widen polls to 5s; these tests only run on dev machines with redis.

## Spec coverage map

| Spec section | Task |
|---|---|
| config.ts atomic trio | 1a |
| cache-sync module (start/publish/apply/stop, redaction, throttled warns, backoff, timeout race) | 1b |
| cache.ts hook | 1c |
| invariants 1,2,4,6,7 | 1b/1d |
| invariants 3,5 (timeout+backoff) | 1b (structure) — integration covers connected path |
| boot wiring + sender env + invariant 8 (drain) | 2a |
| integration tests (skipIf) | 2b |
| docs + message contract | 2c |
