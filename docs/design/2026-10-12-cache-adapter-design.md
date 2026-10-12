# brust cache adapters: an opt-in shared second tier behind the in-process cache (custom TS adapters + built-in Redis/Dragonfly, Cloudflare KV, Cloudflare Durable Object): architecture design

**Status: RULED by lead Detoro 2026-10-12 (R1-R14 in §11 all ACCEPTED as their recommended defaults) — awaiting the HUMAN'S review before lanes are cut.** Key rulings: R1 built-in Cloudflare adapters are opt-in packages; the brust runtime itself still needs only Workers (the §5 rule in the M4-CF spec is amended to say so). R2 one `CacheAdapter` with optional `store` + `broadcast` capabilities (push `subscribe` or pull `since`). R3 the shared tier holds rendered page bodies only; jobs stay local; `key` invalidations are broadcast-only. R4 native read-through via a dedicated `CallKind::Cache`; R5 background write-through, dropped when no worker slot is free; R6 worker 0 receives broadcasts; R7 fail-open budgets (get 50 ms native / 100 ms Workers, poll cap 500 ms); R8 `x-brust-cache: HIT-L2`; R9 KV refuses ttl < 300 s and is documented as a long-TTL store to pair with the DO broadcast; R10 the build generates a 3-line `worker/main.js` re-export so the DO class is bindable (generated, like the entry); R11 bindings are user-declared, the build verifies and prints the snippet; R12 no stampede protection in v1 (documented); R13 Redis/Dragonfly conformance via CI service containers; R14 no entry signing in v1 (documented). Lanes (§10): A `cache-adapter-core` (complex, Dew → Mellow) → B `cache-redis` ∥ C `cache-cloudflare` (standard) → D docs; branch from `m4cf`. The human decision this answers (2026-10-12): "ทำแค่ cache Adapter ไว้ให้ ให้เข้า custom เองได้ ส่วน build-in เราทำ Redis, dragonflydb, cloudflare kv, cloudflare do ไว้ให้". In short: brust defines an adapter interface that users implement themselves, and ships built-ins for Redis, Dragonfly, Cloudflare KV and Cloudflare DO. It supersedes the lane-7 drafts `m4cf-edge-cache` (brust-owned epoch DO) and `m4cf-epoch-hook` (app-supplied epoch hook). Their cursor/replay/ring design is reused here as the pull-model broadcast and as the `cloudflare-do` adapter.

**Lane A landed @70c157f (lane `cache-adapter-core`, plan `docs/plans/2026-10-12-cache-adapter-core.md`, rulings R1-R16 + L1-L7):** the contract (`@brust/core/cache-adapter` + `/conformance`), the memory adapter, the native L2 hooks over `CallKind::Cache`, worker-0 push replay, the Workers bridge + pull cursor, the shared invalidation floor and `stats.l2`. §3, §6, §8 and §10 below are amended to what was built; the HIT path (`get_with`, the probe, `hit_response`) is byte-identical.

Grounding: branch `m4cf` @**eea183f** in `/Users/detoro/code/brust-m4cf`. That commit includes the lane-3 merge 7d842e3 (`crates/brust-wasm`) and the §5 runtime-scope rule eea183f. Every `path:line` was verified there.

Citation key:
- **[C]** = Cloudflare or Bun doc, fetched 2026-10-12.
- **[I]** = inference that a lane must verify.

---

## 0. Verdict

**Feasible without touching the HIT path.** The in-process caches stay tier 1 on every runtime: moka `L1Cache`/`JobCache` on native, `LocalL1`/`LocalJobs` on Workers. An adapter is a TypeScript object living where user code lives: each Bun worker on native, `brust-app.js` on Workers.

Rust reaches the adapter at three points only:
1. **Read-through**: one bounded `get` on an L1 MISS of a cacheable route.
2. **Write-through**: a fire-and-forget `set` after a successful L1 insert.
3. **Invalidation**: a delete-by-tag/path in the shared store, plus a broadcast that every other instance replays into its own tier 1.

The adapter has two **capabilities**, `store` and `broadcast`, so a backend that lacks one can be composed with another (KV store + DO broadcast). All four built-ins and any custom adapter implement the same interface.

The one hard correctness problem is a stale write racing an invalidation: the F86/F89 problem one tier up. It is solved with a **shared invalidation sequence**. Every adapter stamp is a number in its broadcast's sequence space:
- `store.set` carries the stamp read before the loader ran, and a store with atomic writes refuses a stale write (the Redis Lua guard, the DO).
- On Workers, an L2 HIT is also checked against a local "invalidation floor".
- KV cannot refuse a write (no CAS) and propagates in ≥ 60 s [C]. It is therefore documented as a store for long-TTL pages only, never as an invalidation channel.

## 1. Goals / non-goals

**Goals**
- **G1.** `[cache] adapter = "redis" | "dragonfly" | "cloudflare-kv" | "cloudflare-do" | "custom"`. When it is absent, behaviour and bytes are identical to today, and the native bench S/D/I rows stay within noise.
- **G2.** Rendered page bodies are shared across processes, hosts and isolates (store), and invalidations reach every instance (broadcast):
  - Redis/Dragonfly: immediately, via pub/sub;
  - DO: ≤ `epoch_interval_ms` + one poll;
  - KV alone: ≤ ttl + ≥ 60 s propagation.
- **G3.** One TS interface (`CacheAdapter`) with a published conformance suite. Built-ins and custom adapters pass the same cases.
- **G4.** Request-path cost on an L1 MISS is bounded by `get_timeout_ms`, and the adapter fails open: an adapter error is a tier-2 miss, never a 5xx.
- **G5.** Shared entries are scoped to `namespace` + `build_id`, so a deploy never serves bodies rendered by an older build.
- **G6.** `/_brust/cache/stats` gains an `l2` object only when an adapter is configured, so the native JSON stays byte-identical otherwise.

**Non-goals (v1)**
- Sharing job-cache values (tier-1 jobs stay local; a `key` invalidation is still broadcast).
- Redis on Workers (no RESP-over-TCP client that brust can rely on; Upstash-style REST is a custom adapter).
- KV or DO on native.
- Cross-instance render coalescing / distributed locks (R12).
- The Workers Cache `Cache-Tag` edge cache (lane 7b).
- Streaming bodies.

## 2. Architecture

```
 request ─► L1 probe (Rust, in-process) ── HIT ──► 200 x-brust-cache: HIT   (adapter never called)
              │ MISS (cacheable route, no bypass, no set-cookie)
              ▼
         stamp tier-1 clock (pipeline.rs:220)
              │
              ├─ [Workers, pull broadcast] epoch poll ≤ 1×/interval/isolate (≤ 500 ms)
              ▼
         L2 get(key) ──── HIT (valid vs floor) ──► L1 insert(since) ──► 200 x-brust-cache: HIT-L2
              │ miss / timeout / error (fail-open)
              ▼
         loader → jobs → render (unchanged) ──► L1 insert(since) ──ok──► L2 set(stamp) async
                                                                       (native: background worker call;
                                                                        Workers: ctx.waitUntil)
 cache.invalidate(args) [JS, inside an action]
   → local tier 1 (napi cacheInvalidate | wasm rt.invalidate)       (sync, today's behaviour)
   → adapter.store.invalidate(args) + broadcast.publish([{origin, seq?, args}])   (async)
 other instances: subscribe (native worker 0, push) | since-poll (Workers, pull) → replay → tier 1
```

Where the adapter lives:
- **Native.** The adapter is instantiated in every Bun worker (`packages/brust/src/worker.ts:92-119` `startWorker`). Rust calls it through the existing tsfn/SAB seam with a new `CallKind::Cache` (`crates/brust-server/src/dispatch.rs:41-48`). Bodies over the inline threshold use the F82 heap cell (`FetchCell`, `dispatch.rs:214-220`; napi `take_fetch_body`/`put_fetch_reply`, `crates/brust-napi/src/server.rs:259-276`).
  - Broadcast is received by **worker 0 only** (`BRUST_WORKER_ID == "0"`), which replays through napi `cacheInvalidate` (`server.rs:317`). One replay per process, not one per worker.
- **Workers.** The adapter is imported by the generated entry and returned from `install(rt)`. Today `bridge.rs:39` `js_install(rt) -> Result<(), JsValue>` and `cf-entry.ts:44` re-exports `install`. `WasmHost` calls its functions directly: there is no SAB, and bodies cross as `Uint8Array`.
  - The pull-model cursor (first-contact adopt, ordered replay, own-echo skip, clear on gen change/behind/gap) lives in `crates/brust-wasm/src/epoch/`. It is driven at the start of `fetch` (`entry.rs:67` onward), before `core.handle`.

## 3. Interfaces

### 3.1 TypeScript (exported from `@brust/core/cache-adapter`)
```ts
export interface StoredPage { status: number; headers: [string, string][]; body: Uint8Array }  // identity body
export interface SetMeta { ttlMs: number; tags: string[]; method: string; path: string; stamp: number | null }  // null = unguarded
export interface GetResult { page: StoredPage | null; stamp: number | null; entryStamp: number | null; storedAt: number | null }
// stamp = the broadcast seq NOW (the base of the set that may follow); entryStamp = the stamp the entry was written under (L1)
export interface CacheStore {
  get(key: string): Promise<GetResult>                       // stamp = broadcast seq now (write-guard base)
  set(key: string, page: StoredPage, meta: SetMeta): Promise<boolean>  // false = refused (stale stamp)
  invalidate(args: InvalidateArgs): Promise<void>            // shared-side delete (tags/path); key → no-op; records the marker BEFORE deleting (L7b)
  readonly maxBodyBytes: number
}
export interface InvalidationEvent { seq: number; origin: string; args: InvalidateArgs }
export interface EpochSince { gen: string; seq: number; behind: boolean; events: InvalidationEvent[] }
export interface CacheBroadcast {
  publish(args: InvalidateArgs, origin: string): Promise<number>    // returns the assigned seq
  // exactly one of:
  subscribe?(on: (e: InvalidationEvent) => void, onGap: () => void): Promise<() => Promise<void>>  // push
  since?(seq: number): Promise<EpochSince>                                                        // pull
}
export interface CacheAdapter {
  readonly name: string
  readonly runtimes: ReadonlyArray<'bun' | 'workers'>
  store?: CacheStore
  broadcast?: CacheBroadcast
  init?(ctx: { namespace: string; buildId: string; runtime: 'bun' | 'workers'; workerId: number }): Promise<void>
  close?(): Promise<void>
}
export type CacheAdapterFactory = (options: Record<string, unknown>) => CacheAdapter
```
Rules:
- A broadcast with `subscribe` is push; one with `since` is pull.
- On Workers only pull is allowed: no connection outlives a request. A push-only adapter is a build error under `--target cloudflare`.
- `stamp` and `seq` share ONE sequence space per adapter (the broadcast's). A store without a broadcast returns `stamp: null`, and its writes are unguarded.
- **Marker before delete (L7b).** `store.invalidate` records the per-tag / per-`method path` marker at the seq its publish will take (the reference memory adapter: current seq + 1) BEFORE deleting, and `set` refuses when a marker > its stamp. A stale `set` racing the invalidation is refused even before the publish (conformance case).
- **Subpaths (R15).** `@brust/core/cache-adapter` (types, `memoryAdapter`, `defineCacheAdapter`; no `bun`/`bun:*` import, so it bundles into a Worker) and `@brust/core/cache-adapter/conformance` (`runConformance(make, { push?, pull?, guard? })`, bun:test).

### 3.2 Rust (`crates/brust-core`)
- **As built** (`crates/brust-core/src/l2.rs`): `L2Config { adapter, get_timeout, max_body_bytes, namespace, build_id }`, `L2Key`, `L2Probe { key, path, tags }`, `L2Page`, `L2SetMeta`, `L2Lookup = Off | Miss{stamp} | Floor{stamp} | Hit{page, stamp, entry_stamp, stored_at_ms} | Timeout | Failed`, `L2Counters`/`L2Stats`, `remaining_ttl` (R6: `ttl − age`, clamped to [1 s, ttl]; expired = miss), and the **invalidation floor** `Floor`/`SharedFloor` (ruling L7c: shared by native and Workers; `Core::l2_replay(args, seq)` raises it, the pipeline checks it on every L2 hit, a same-generation gap sets a global floor, a new generation resets it). `PageCache`/`JobStore` gain `clear_all`; `Clock` gains `wall_ms`; `Core` gains `l2`, `l2_counters`, `l2_floor`, `l2_count`, `clear_local`, `l2_replay`. Write-through happens on any `Miss{stamp}`/`Floor{stamp}` (L2); `null` = unguarded; never on `Timeout`/`Failed`/`Off`. The L2 block is two `#[cold]` helpers behind one `Option` check.
- **`CoreConfig`** (`core.rs:27-37`) gains `l2: Option<L2Config { get_timeout: Duration, max_body_bytes: usize, namespace: String, build_id: String }>`.
- **`Host`** (`host.rs:189-224`) gains two methods with default bodies, so a host without L2 compiles unchanged:
  ```rust
  fn l2_get(&self, key: &L2Key) -> impl Future<Output = L2Lookup> { async { L2Lookup::Off } }
  fn l2_set(&self, key: L2Key, body: &Arc<RenderedBody>, meta: L2SetMeta) {}   // spawns; never awaited
  ```
  - `L2Lookup = Off | Miss { stamp: Option<u64> } | Hit { body: RenderedBody, stamp: Option<u64>, stored_at: Option<u64> } | Failed(L2Error)`.
  - `L2Key` = `"<namespace>:<build_id>:p:" + hex(blake3(prefix ‖ 0 ‖ method ‖ 0 ‖ path ‖ 0 ‖ sorted_query))` over `CacheKey` (`cache/mod.rs:17-23`) — blake3, already a dependency (R7).
  - `build_id` = the first 16 hex chars of sha256 over the manifest (without `cache`), every `jinja/*.jinja` (by name), `jobs.js` and `actions.js`, computed **by the build** (R7) and written to `manifest.cache.buildId` / `CONFIG.cache.buildId`.
- **`pipeline::page`** (`pipeline.rs:176`) changes in two places:
  1. after the stamp (:220), and only when `s.l2.is_some() && cache_key.is_some()` (bypass/uncached routes have none), it awaits `s.host.l2_get(..)` under `get_timeout`. A valid `Hit` → `RenderedBody` → `s.l1.insert(k, Arc::new(b), ttl, tags, since)` → `hit_response` + `x-brust-cache: HIT-L2`.
  2. at the L1 store (:473-480), when `insert` returned `true` and the L2 lookup produced a stamp → `s.host.l2_set(..)`.
  - Set-cookie pages are already not stored (:291, :365), so they never reach L2.
  - `bench/attribution.patch` hunks in `pipeline.rs` must be regenerated (lane A).
- **`Stats`** (`config.rs` `Stats`, shape pinned at :294) gains `#[serde(skip_serializing_if = "Option::is_none")] l2: Option<L2Stats>`.
- **`InvalidateArgs`** (`config.rs:160-171`) derives `Serialize, Clone, PartialEq`.

### 3.3 Native wire (`CallKind::Cache`)
- **Request** (inline JSON, per the SAB rule `dispatch.rs:8-21`): `{"op":"get","key":…}` | `{"op":"set","key":…,"status":…,"headers":[…],"meta":{ttlMs,tags,method,path,stamp},"heap":n}`. The set body ALWAYS waits in the call's `CacheCell { body, reply, cap }` (the `FetchCell` twin; `take_fetch_body`/`put_fetch_reply` accept both, each with its own cap), and JS takes it with `takeFetchBody(slot)`. Only `get` and `set` cross Rust → JS (R2); invalidate/publish start in the JS `cache.invalidate` wrapper, subscribe at worker 0's boot.
- **Response:**
  - `get` hit: `{"hit":true,"status":…,"headers":[…],"stamp":…,"storedAt":…,"heap":n}`, the body via `putFetchReply` (F82 framing, `decode_fetch_reply` `dispatch.rs:277-305`);
  - otherwise `{"hit":false,"stamp":…}`, or `{"error":…}`.
- `worker.ts:47-69` `makeDispatch` gains `kind === 'cache'`, and `crates/brust-napi/src/dispatch.rs:57-62` `kind_str` gains `"cache"`.
- **Claims.**
  - `get` uses the normal claim (`claim_timeout`, default 10 s, `server/mod.rs:73`) but is wrapped in `get_timeout`.
  - `set` claims with a zero wait (`claim_or_wait(.., Duration::ZERO, ..)` over `try_claim_render_lockfree`, `pool.rs:480`). When no slot is free, the set is **dropped** and `l2.set_dropped`++, so background writes never queue behind page work.
- **napi** (as built): `StartOptions.l2`, `cacheReplay(args, seq)` (worker 0's replay: tier 1 + the floor, never re-published — L3), `cacheL2Count(name)`, `cacheClear()`. The JS bridge (`cache-adapter/bridge.ts` `runCache`) races `get` with `getTimeoutMs` and `set` with 5 s, so a hung adapter never pins a slot.
- **Workers wire (as built, R11/R14).** `install(rt, ext)` gets `rt = { invalidate, l2Count }` and answers `{ cache: { origin, get?, set?, since? } }`: `get(key) → {json, body}`, `set(key, json, body)` (deferred with `waitUntil`), `since(seq) → string`. A Worker may not draw random values at start, so the isolate origin and the memory adapter's `gen` are made on first use. The pull cursor (`crates/brust-wasm/src/epoch/`) is polled at most once per `epoch_interval_ms`, single-flight, 500 ms cap, inside the per-request `catch_unwind` future (L6).

### 3.4 Workers wire
- The generated entry imports the adapter module/factory and passes it to `install(rt, { cache })`. `install` returns `{ cache }`, and `bridge::install` keeps the JS functions.
- `WasmHost::l2_get` calls `store.get(key)` → `JsFuture` raced against `worker::Delay(get_timeout)`.
- `l2_set` → `ctx.wait_until(store.set(..))`. `ctx` reaches the host through a per-request cell set in `entry.rs` `fetch` (today `_ctx`, :68).
- `cache.invalidate` stays the `rt.invalidate` closure (`bridge.rs:64-77`) for tier 1. The JS wrapper then runs `store.invalidate` + `broadcast.publish` under `waitUntil` (imported from `cloudflare:workers` in the CF bundle).

## 4. Semantics

### 4.1 Which ops are synchronous on the request path
| op | when | on the path? | budget (default) | on failure |
|---|---|---|---|---|
| L1 probe | every cacheable GET/HEAD | yes, in-process | µs (unchanged) | — |
| epoch poll (`since`) | Workers, pull broadcast, the first GET after `epoch_interval_ms` per isolate | yes, single-flight | 500 ms cap | fail-open: serve tier 1, `poll_errors`++ |
| `store.get` | L1 MISS on a cacheable route with a store | yes | `get_timeout_ms`: native 50, Workers 100 | treat as a miss (no stamp → no set) |
| `store.set` | after a successful L1 insert of a MISS | no | — | native: dropped if no free slot; errors counted |
| `store.invalidate` + `publish` | inside `cache.invalidate` (JS) | no (floating on native, `waitUntil` on Workers) | — | `publish_errors`++; other instances stale ≤ ttl |
| replay of received events | native worker 0 push; Workers poll | no / in the poll | — | gap → clear tier 1 |

Expected costs:
- One tsfn crossing is tens of µs (memory "napi crossing floor": JS-bridged routes cap at ~60k RPS) [I].
- A same-region Redis GET is sub-ms [I].
- KV reads are fast when hot but cold reads go to central storage [I].

The HIT path and every non-cacheable route are untouched.

### 4.2 Correctness rules
1. **Tier-1 guard (unchanged).** The local stamp is taken before `l2_get`, so a local invalidation during the get refuses the L1 insert of the fetched body (F86).
2. **Tier-2 write guard.** `store.get` returns `stamp` = the broadcast seq at read time, which precedes the loader. `store.set` must refuse when any `tag`, or the `(method, path)`, was invalidated with a seq > `stamp`:
   - Redis: Lua, atomic;
   - DO: single-threaded;
   - KV: impossible (no CAS), so the stale window is ≤ ttl, documented.
3. **Invalidation floor (Workers).** The cursor remembers, in a bounded LRU of 4096 entries, the last replayed seq per tag and per path. An L2 hit whose `stamp` is below the floor of one of its tags/path is discarded as a miss. This closes the KV+DO case where a colo still holds a deleted body.
4. **Own echo.** Every event carries `origin` (the worker or isolate id). Replay skips its own events: tier 1 is already invalidated.
   - **Own replay (review F1, lane A).** Between the tier-1 primitive and the store delete, a request on the origin can re-fill tier 1 from the old L2 body, and its echo is skipped. So once its publish settles, the origin replays its own invalidation exactly once through the host REPLAY primitive (napi `cacheReplay` / wasm `rt.replay` → `Core::l2_replay(args, seq)`): tier 1 again and the floor at the publish seq. It is never published again (L3). No broadcast or a failed publish → tier 1 only (`seq` null).
5. **Gaps.**
   - Push: on (re)subscribe, and in a 10 s reconciliation that reads the store's seq, a seq beyond the last seen → `onGap` → clear tier 1.
   - Pull: `behind`, a `gen` change, a regression, or a count mismatch → clear (the cursor rules of the epoch-hook draft).
6. **Build scoping.** Keys include `build_id`, so a deploy starts a fresh key space. Old keys expire by TTL. Events are build-agnostic: args are route-level.
7. **`key` invalidations** (job user keys) are broadcast and replayed into remote job caches. The shared store holds pages only, so `store.invalidate` ignores `key`.

### 4.3 Per-backend semantics (spec table)
| | native only | Redis / Dragonfly | Cloudflare KV | Cloudflare DO | custom |
|---|---|---|---|---|---|
| runtimes | — | Bun only | Workers only | Workers only | declared in `runtimes` |
| store | — | shared bodies, `PX` = ttl | shared bodies, `expirationTtl` ≥ 60 s (routes with ttl < 60 s are not written) [C] | optional (`do_store`), sharded SQLite rows ≤ 2 MB [C] | optional |
| write guard | — | exact (Lua) | none: stale write window ≤ ttl | exact | adapter-defined |
| broadcast | — | pub/sub push: immediate on every subscribed process | **none reliable**: propagation "up to 60 seconds or more", 1 write/s per key, cacheTtl ≥ 30 s [C] → compose with `broadcast = "cloudflare-do"` | pull ring: ≤ interval + RTT, strongly consistent | push or pull |
| other instances after `invalidate` | n/a | ≈ pub/sub latency | ≤ ttl (alone); ≤ interval + RTT (with DO) but bodies may be re-read stale ≤ 60 s unless the floor (4.2.3) rejects them | ≤ interval + RTT | — |
| failure mode | — | fail-open + gap clear | fail-open | fail-open; DO restart → `gen` change → clear | — |
| limits [C] | — | value 512 MB (brust caps at `max_body_bytes`) | value 25 MiB, key 512 B, metadata 1 KiB; Free 1,000 writes/day | row 2 MB, 1,000 req/s per object, Free 100k req/day | — |

What KV can give: cheap, global, read-mostly bodies for long-TTL pages (docs, catalogue). What it cannot give: prompt invalidation, write ordering, or any guarantee that an invalidated body is not served again within ~60 s. On the Free plan, write-through exhausts 1,000 writes/day quickly. The KV adapter therefore refuses `set` for ttl < `kv_min_ttl_s` (default 300) [R9].

## 5. Built-in backend designs

### 5.1 Redis and Dragonfly (`@brust/cache-redis`; `adapter = "redis" | "dragonfly"`, one implementation)
- **Client.** Bun's built-in `RedisClient` (`import { RedisClient } from "bun"`): RESP3, auto-reconnect, `send()` for any command, `getBuffer` for binary values, Pub/Sub "added in Bun 1.2.23" and marked experimental; servers ≥ 7.2 [C https://bun.com/docs/runtime/redis]. The repo runs Bun 1.4.3. There is no npm client dependency.
  - Pub/sub needs a dedicated connection: worker 0 opens a second client.
  - `dragonfly` = the same code with Dragonfly defaults (no `CLIENT TRACKING`, scripts declare every key: Dragonfly rejects undeclared-key Lua by default [I]).
- **Keys.** All keys sit in one hash slot `{brust:<ns>}` so multi-key Lua works on Redis Cluster:
  - `{…}:<build>:p:<h>` holds the body as one binary string: `[u32 LE meta_len][meta JSON {status, headers, tags, method, path, stamp, storedAt}][body]`, with `PX` = ttl;
  - `{…}:<build>:t:<tag>` is a SET of body keys; `{…}:<build>:q:<method> <path>` is a SET of body keys;
  - `{…}:seq` is an INCR counter;
  - `{…}:ts:<tag>` and `{…}:ps:<method> <path>` hold the seq of the last invalidation (`EX` = 2 × max ttl).
- **`get`:** `MGET body, seq`, which also returns the stamp in one round trip.
- **`set`:** Lua with every key declared. If any `ts`/`ps` > stamp → return 0. Else `SET body PX` + `SADD` the indexes + `PEXPIRE` the index to max(current, ttl) → 1.
- **`invalidate` + `publish`:** Lua 1 (declared keys): `INCR seq` → set `ts`/`ps` = seq → `SUNION` the index sets → `DEL` the sets → return `{seq, members}`. Then the client `UNLINK`s the members in batches of 500. Members are not declared, so they are deleted outside the script; that is safe because the write guard already refuses re-inserts. Then `PUBLISH {…}:inv {seq, origin, args}`.
- **Subscribe:** worker 0 `SUBSCRIBE {…}:inv` → `cacheInvalidate(args)` (napi) unless `origin` is this process. Gap detection as in 4.2.5. A process restart starts with an empty tier 1, so it needs no catch-up.

### 5.2 Cloudflare KV (`@brust/cache-cloudflare/kv`; `adapter = "cloudflare-kv"`)
- **Binding:** `kv_binding` (default `BRUST_CACHE`), user-declared in `wrangler.jsonc` (spec R8). The build errors if it is absent.
- **`get`:** `KV.getWithMetadata(key, {type: "arrayBuffer", cacheTtl: 60})`; metadata = `{status, headers, tags, method, path, stamp, storedAt}` (≤ 1 KiB, else not stored). `stamp` is `null` unless composed with a DO broadcast, which supplies the cursor seq.
- **`set`:** `put(key, body, {expirationTtl: max(ttl, 60), metadata})`, plus a marker key `…:t:<tag>:<h>` per tag (empty value, same TTL).
- **`invalidate`:** `list({prefix: "…:t:<tag>:"})` → delete markers + bodies. It is best-effort and eventually consistent [C].

### 5.3 Cloudflare Durable Object (`@brust/cache-cloudflare/do`; `adapter = "cloudflare-do"`)
- **Broadcast (always):** class `BrustCacheDO`, singleton `getByName("brust-epoch")`. It holds an in-memory ring: `gen` (random), `seq`, the last 1024 events / 1 MiB, with an oversize event stored as a clear marker. RPC `since(seq)` / `publish(args, origin)`. There are no storage writes; a restart means a new `gen`, which makes every isolate clear once.
- **Store (opt-in, `do_store = true`):** 16 shard objects `getByName("brust-store-<i>")`, chosen by key hash. Each has SQLite tables `pages(key, meta, body, expires_at)`, `tags(tag, key)`, `inval(name, seq)`, and an alarm sweep.
  - The write guard is exact: `publish` fans the seq to all shards, which costs 16 subrequests per invalidation. That is within the Free limit of 50 per invocation [C].
- **Class export.** The deployed `main` is worker-build's glue, and its shim exports only wasm-bindgen classes (`worker-build-0.8.7/src/main.rs:231-272`). A JS DO class cannot be bound from inside the brust Worker today. R10 rules how `BrustCacheDO` is exported.

### 5.4 Custom (`adapter = "custom"`, `module = "lib/cache.ts"`)
- The default export is a `CacheAdapter` or a `CacheAdapterFactory` (called with `[cache.options]`).
- It is bundled into `brust-app.js` for Workers and imported per Bun worker on native.
- The authoring doc ships two worked examples: Upstash REST (Workers + Bun) and an in-memory test adapter.

## 6. Configuration (`brust.toml`)
```toml
[cache]
adapter = "redis"              # redis | dragonfly | cloudflare-kv | cloudflare-do | custom ; absent = none (today)
broadcast = "cloudflare-do"    # optional: compose another adapter's broadcast (e.g. KV store + DO broadcast)
module = "lib/cache.ts"        # custom only
namespace = "pokedex"          # default: package.json name
get_timeout_ms = 50            # native default 50, Workers default 100; 1..=1000
max_body_bytes = 1048576       # bigger bodies are not written to L2
epoch_interval_ms = 1000       # pull broadcasts only; 250..=60000
[cache.redis]
url = "env:REDIS_URL"          # `env:` indirection only — a literal URL with a password is a build error
[cache.cloudflare]
kv_binding = "BRUST_CACHE"
do_binding = "BRUST_CACHE_DO"
do_store = false
kv_min_ttl_s = 300
[cache.options]                # passed to a custom factory
```
- **As built (R4, R8).** `max_body_bytes` defaults to 1048576 (1..=67108864). `module` (custom) must be a file inside the app; natively it is bundled to `dist/cache-adapter.js`, on Workers the generated entry imports the source. Built-ins resolve from the app root (`Bun.resolveSync`) with an install hint when missing: `redis` → `@brust/cache-redis`, `dragonfly` → `@brust/cache-redis/dragonfly`, `cloudflare-kv` → `@brust/cache-cloudflare/kv`, `cloudflare-do` → `@brust/cache-cloudflare/do` (each subpath's default export is a factory). `[cache.redis]` feeds redis/dragonfly, `[cache.cloudflare]` feeds kv/do, `[cache.options]` feeds custom. `[cache.redis].url` must be `env:NAME` (resolved from the worker's env at boot); any `env:` option on `--target cloudflare` is a build error. `broadcast` names a built-in only. Native accepts push broadcasts only (R1); Workers accept pull only (R14, checked by the build smoke).
- Native: `brust start` reads `[cache]`, passes `L2Config` to `startServer` (a new `StartOptions.l2`, `crates/brust-napi/src/server.rs:146-171`), and each worker instantiates the adapter.
- Workers: `brust build --target cloudflare` validates the runtime support, bundles the adapter, and writes `CONFIG.cache` (`cf-entry.ts:3-12`). The wasm `CfConfig` (`deny_unknown_fields`, `crates/brust-wasm/src/config.rs:10`) gains the field.

## 7. Packaging
| package | contents | deps |
|---|---|---|
| `@brust/core` | `cache-adapter` subpath: types, `runConformance()`, the in-memory test adapter; the native and Workers wiring | none new |
| `@brust/cache-redis` | `redis` + `dragonfly` factories (Bun `RedisClient`) | none (peer `@brust/core`; engines `bun >= 1.2.23`) |
| `@brust/cache-cloudflare` | `/kv`, `/do` factories; `/do-class` (`BrustCacheDO`) | none (peer `@brust/core`; types from `@cloudflare/workers-types` as a dev dep) |

Core never depends on a Redis client or on Cloudflare types at runtime. Each name resolves from the app root (`Bun.resolveSync`); a missing package gives `adapter "redis" needs @brust/cache-redis (bun add @brust/cache-redis)`.

## 8. Metrics (`/_brust/cache/stats`, present only with an adapter)
`"l2": {"adapter":"redis","hits":0,"misses":0,"timeouts":0,"errors":0,"rejected_floor":0,"sets":0,"set_refused":0,"set_dropped":0,"published":0,"publish_errors":0,"received":0,"skipped_own":0,"resets":0,"epoch_polls":0,"poll_errors":0}`

- **As built (R9):** `set_oversize` follows `set_dropped`. Rust counts the request-path fields (`hits`, `misses`, `timeouts`, `errors`, `rejected_floor`, `set_*`, native `sets`/`set_refused`, Workers `epoch_polls`/`poll_errors`/`received`/`skipped_own`, `resets` on every tier-1 clear). The JS side counts `published`/`publish_errors` (and native `received`/`skipped_own`, Workers `sets`/`set_refused`) through napi `cacheL2Count(name)` / `rt.l2Count(name)` into the one per-process (native) / per-isolate (Workers) object.
- On Workers `/_brust/cache/stats` is gated by `[cloudflare] stats` (lane 3 R11), and the numbers are per isolate.

## 9. Tests
- **Conformance suite** (`@brust/core/cache-adapter` `runConformance(make, caps)`, bun:test cases, also exported for custom authors). It covers:
  - get miss/hit, binary-safe bodies (all 256 byte values), headers order and repeats, ttl expiry;
  - tag and path invalidation (and that unrelated keys survive), `key` invalidation as a store no-op;
  - the write guard refusing a stale stamp;
  - publish → subscribe delivery or `since` contiguity, `origin` round trip, `behind`/gap → reset;
  - `maxBodyBytes`.
- **Redis/Dragonfly:** CI service containers (`redis:7.4`, `docker.dragonflydb.io/dragonflydb/dragonfly`) on the ubuntu job; locally gated on `REDIS_URL` / `DRAGONFLY_URL` (R13).
- **KV/DO:** a fixture Worker (`tests/fixtures/cf-cache`) under local workerd (`wrangler dev`, Miniflare-simulated KV and DO). bun:test drives each conformance case through a test-only route that runs the case inside the isolate.
- **Pipeline e2e:**
  - native: two `brust start` processes on one Redis. A renders `/items/7` → B answers `HIT-L2`. An action on A → B's next GET is a MISS within 1 s (polled). With Redis stopped, pages still 200 (fail-open);
  - Workers: KV and DO through cf-cache with an e2e-only L1 clear route to force the L2 path; the DO ring cases (replay, own echo, overflow, gen change, failure, timeout) carried over from the epoch drafts.
- **Native no-adapter guard:** `tests/server/pokedex.test.ts`, battery and m2-exit unchanged; bench S/D/I within noise (lane A gate).

## 10. Lanes (branch from `v2` after `m4cf` merges, or from `m4cf`: R14)
| # | slug | tier / review | boundary | goal |
|---|---|---|---|---|
| A | `cache-adapter-core` | complex / complex | (as built: plus `crates/brust-core/src/{l2,protocol}.rs`, `crates/brust-server/src/{actions,config,lib}.rs` + `tests/{l2.rs,common/**}`, `crates/brust-wasm/src/epoch/{cursor,sync}.rs`, `packages/brust/src/cache-adapter/{types,memory,conformance,runtime,bridge,load,workers}.ts`, `build/{bundle,manifest}.ts`, `run.ts`, `tests/fixtures/{l2-relay,cf-l2}`, `tests/server/{cache-adapter.test.ts,l2-relay.ts}`, `tests/cf/cache-adapter.test.ts`) `crates/brust-core/src/{host,core,config,pipeline}.rs`, `crates/brust-server/src/{dispatch,host}.rs`, `crates/brust-napi/src/{dispatch,server}.rs`, `crates/brust-wasm/src/{bridge,entry,host,config}.rs` + `epoch/**`, `packages/brust/src/{cache-adapter/**,worker.ts,cache.ts,config.ts,server-handlers.ts,build/{config,cf-entry,cloudflare}.ts}`, `bench/attribution.patch` | interface + conformance + in-memory adapter; Host L2 hooks + pipeline; `CallKind::Cache`; the Workers bridge + cursor; stats; `custom` works on both runtimes; bench within noise |
| B | `cache-redis` | standard / standard | `packages/cache-redis/**`, `.github/workflows/ci.yml` (services), `tests/server/l2-redis.test.ts` | Redis + Dragonfly pass conformance; two-process e2e |
| C | `cache-cloudflare` | standard / complex | `packages/cache-cloudflare/**`, `packages/brust/src/build/{cf-wrangler,cloudflare}.ts` (R10/R11), `tests/fixtures/cf-cache/**`, `tests/cf/**` | KV + DO (+ `do_store`) pass conformance under workerd; class export per R10 |
| D | docs | docs-only | `docs/cache-adapters.md`, `docs/cloudflare.md`, spec §5 | the semantics table, cost tables (DO, KV), the custom-adapter guide, the Upstash example |

Order: A → (B ∥ C) → D.

## 11. Rulings requested
| R | Question | Recommended default | Alternative |
|---|---|---|---|
| R1 | Scope vs the 2026-10-12 "Workers only" rule (eea183f) | built-in Cloudflare adapters are **opt-in packages**; the brust runtime itself still needs only Workers; amend the §5 rule text | keep "Workers only" absolute and ship KV/DO as docs examples (human already asked for built-ins) |
| R2 | Interface shape | one `CacheAdapter` with optional `store` + `broadcast` capabilities; broadcast is push (`subscribe`) or pull (`since`); `publish` returns the seq | flat `get/set/delete/invalidate/subscribe` (no composition; KV cannot honestly implement `subscribe`) |
| R3 | What the shared tier stores | rendered page bodies only (identity body + validated headers); jobs stay local, `key` is broadcast-only | also job values (more hits for ssr jobs; doubles the write guard surface) |
| R4 | Native read-through transport | a dedicated `CallKind::Cache` call before the loader call | piggyback the `get` on the loader call (saves one crossing on an L2 miss, but conflicts with the P6 plan cell and the F82 cell in one slot) |
| R5 | Native write-through | background, `try_claim_render_lockfree`; drop when no slot is free | a bounded queue (no drops; under load writes compete with renders) |
| R6 | Where native broadcast is received | worker 0 of each process (one subscription, napi replay) | every worker (N× replays, N connections) |
| R7 | Request-path budgets | `get_timeout_ms` native 50 / Workers 100; epoch poll cap 500 ms; fail-open everywhere | fail-closed (5xx when L2 errors) — not recommended |
| R8 | L2 hit header | `x-brust-cache: HIT-L2` (new value, only with an adapter) | `HIT` (hides tier; debugging harder) |
| R9 | KV write policy | refuse `set` for ttl < `kv_min_ttl_s` = 300; docs say "KV = long-TTL store; pair with `broadcast = "cloudflare-do"`" | write every cacheable page (exhausts Free 1,000 writes/day; stale ≤ ttl) |
| R10 | Exporting `BrustCacheDO` from the deployed Worker | the build generates `worker/main.js` = `export { default } from "./index.js"; export * from "./index.js"; export { BrustCacheDO } from "./brust-cache-do.js"`, and wrangler `main` points to it (a generated re-export, H3-compatible); this also unlocks user DO classes later | (a) implement the DO class in Rust in `brust-wasm` (`#[durable_object]`; adapter logic split across languages); (b) a second Worker bound via `script_name` (two deploys) |
| R11 | Cloudflare bindings | user-declared in `wrangler.jsonc` (spec R8); the build verifies them and prints the exact snippet when one is missing | auto-add binding + class declaration in `cf-wrangler.ts` |
| R12 | Stampede protection | none in v1; document; follow-up: process-local single-flight of MISS renders | Redis `SET NX PX` render lock (cross-instance; adds a round trip to every MISS) |
| R13 | Redis in tests | CI service containers (redis + dragonfly); locally env-gated | Bun-spawned `redis-server` binary (needs it on every dev machine) |
| R14 | Entry integrity | none (the store is a trusted backend; namespace + build id only) | HMAC-SHA256 over meta+body with `[cache] sign_key = "env:…"` (protects against a shared Redis being writable by others) |

## 12. Risks
- **Native regression.** The `l2_get`/`l2_set` branches sit on the MISS path only, guarded by `s.l2.is_some()`. Lane A carries the bench gate (≤ 3% on two runs, rule:bench-hold) and regenerates `attribution.patch`.
- **Worker-slot contention.** A cache `get` claims a worker slot like a loader call. Under saturation `get_timeout` caps the wait. `set_dropped` and `timeouts` in stats make the effect visible.
- **Pub/sub reliability.** Bun's pub/sub is "experimental" [C]. Gap detection turns any loss into a tier-1 clear, never staleness. Dragonfly compatibility is proven by the conformance run, not assumed.
- **KV eventual consistency.** It is documented as such. The floor check (4.2.3) needs a seq space, which KV only has when composed with a DO broadcast.
- **DO hot spot.** One epoch object takes ≤ 1 request per isolate per interval; the soft limit is 1,000 req/s per object [C]. `do_store` shards bodies 16 ways. The cost table from the epoch drafts goes into the docs: Free 100k DO requests/day ≈ one busy isolate at 1 s.
- **Secrets.** `url` accepts only `env:` indirection, and adapters must never log option values.
- **Build skew.** `build_id` scoping means a deploy loses L2 warmth by design. The docs say so.
