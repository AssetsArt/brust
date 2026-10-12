# cache-adapter-core: the CacheAdapter contract, conformance suite and memory adapter; native and Workers L2 hooks (read-through, write-through, invalidation broadcast and replay)
**RULED by lead Detoro 2026-10-12 (before dispatch): R1-R16 ALL ACCEPTED as their defaults (incl. R4 body cap 1 MiB per spec §6 — the lead's earlier 8 MiB suggestion is withdrawn; R7 the build computes `build_id` (sha256 of the manifest), Rust hashes keys with blake3; R13 CONFIG abi stays 1; R15 conformance on its own subpath `@brust/core/cache-adapter/conformance` because the CF build rejects `bun:*`; R16 the ci.yml lines are in-boundary). The implementer's six points stand as L1-L6 (entryStamp; write on any Miss{stamp}; replay never re-publishes; no bench on the main host — Illenium measures S/D/I ≤ 3% twice on the remote host after READY; cursor in brust-wasm/src/epoch + in-memory pull broadcast; epoch poll inside the guarded future). Three HIT-path gates (GET_WITH / PROBE / HIT_RESPONSE unchanged) and the attribution.patch regen are mandatory. Base: m4cf @cfacdd3 or later; worktree via `conclave lane start` FROM /Users/detoro/code/brust (bb rule:worktree-location). Implementer Dew, reviewer Mellow.**
owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · base: m4cf @cfacdd3 or later (lane/m4cf-pokedex-d1 merged) · lane: cache-adapter-core · tier: complex · review: complex
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

This is lane A of the ruled spec `docs/design/2026-10-12-cache-adapter-design.md` (R1-R14 accepted as defaults; human approval on record). Read the spec in full before Task 2: §3 interfaces, §4 semantics, §6 config, §7 packaging, §8 metrics, §9 tests, §10 lanes. Lanes B (`cache-redis`) and C (`cache-cloudflare`) build only on what this lane exports. Implementer: Dew.

Grounding: `m4cf` @**bfd88d1**, re-checked at **cfacdd3** (the pokedex-d1 merge). Between the two, the only changes inside this lane's files are `packages/brust/package.json` (+1 line) and the new `packages/brust/src/cf.ts`, so every `path:line` below holds at cfacdd3. The m4cf worktree is now `/Users/detoro/code/brust/.claude/worktrees/m4cf`. `[PD1]` marks a pokedex-d1 fact. `[I]` marks an inference a task verifies.

## Facts the plan rests on
- **Core config and state** (`crates/brust-core/src/core.rs`): `CoreConfig` :27-37; `Core` :40-83 (`pub(crate) l1` :50, `#[doc(hidden)] pub jobs` :51-52, `clock` :54); `Core::invalidate` :151-165 (key → jobs, tags → both, path → L1); `stats()` :167-177.
- **Host seam** (`host.rs`): `trait PageCache` :157-174, `trait JobStore` :177-195, `trait Host: Clock` :198-230 (`loader`, `jobs`, `read_body`, `action`, `static_file`; RPITIT, no `Send` bound, module doc :6-8). Neither cache trait has `clear`. The inherent ones are `L1Cache::clear` (`brust-server/src/cache/l1.rs:553`), `JobCache::clear` (`job_cache.rs:417`), `LocalL1::clear -> usize` (`cache/local.rs:331-339`) and `LocalJobs::clear` (:515-518). The test trait `ConformL1::clear` (`cache/conformance.rs:24`, :37) has the same name.
- **Clock** (`cache/stamp.rs:15-29`): `InvalClock::stamp() -> ReadStamp`, `next()`; one per `Core` (`core.rs:102-103`).
- **Args and stats** (`config.rs`): `InvalidateArgs` :160-171 (`Debug, Default, Deserialize` only); `Stats` :180-194; the shape is pinned by `stats_json_shape_is_stable` :293-314. The actions cap constants are at :65-74 (`DEFAULT_MAX_ACTION_RESPONSE_BYTES` 8 MiB, `MAX_ACTION_BYTES` 64 MiB, `ACTION_INLINE_BODY_BYTES` 256 KiB).
- **Pipeline** (`pipeline.rs`): `CacheOutcome` :35-52; `handle` :64-143 (stats route :100-104 serialises `s.stats()`); `page` :176; `l1_decision` :919-1018 returns a key only for a route with `cache`, not bypassed, no repeated or colliding names. So bypass and uncached routes have `cache_key = None`; The HIT probe is :199-216 (`s.l1.get_with` :204). The stamp is `let since = s.clock.stamp();` :220; Set-cookie makes a page uncacheable (:291, :365); a rejected job insert does too (:396, :436); `store` = `cache_key.is_some() && status == 200 && cacheable && route.cache.is_some()` :454. The L1 insert is :471-480; `page_response` :676-700, `hit_response` :703-713 (static `Some("HIT")`), `cached_body` :643-653.
- **Keys** (`cache/mod.rs:17-23`): `CacheKey { prefix, method, path, sorted_query }`; `RenderedBody` :29-40. `blake3 = "1"` is already a brust-core dependency (`Cargo.toml`); `sha2` is not.
- **Wire** (`protocol.rs`): `FetchBody::Heap(usize)` :240-245, `FetchMeta { status, headers, heap: Option<u64> }` :249-256.
- **Native dispatch** (`crates/brust-server/src/dispatch.rs`): module doc :8-21 (inline request JSON, SAB only for the response); `CallKind {Loader, Jobs, Fetch}` :41-48 (serde lowercase); `claim_or_wait` :134-167; `FetchCell { body, reply }` :217-220; `call_worker_fetch` :224-246; A2 framing `fetch_frame_parts`/`decode_fetch_frame` :248-275; `decode_fetch_reply` :279-305; `call_worker_decoded` :314-391 (claims via `pool.try_claim_render_lockfree()` :324; the `Detach` remainder keeps the claim until JS settles; `SlotDeadline` at `call_timeout`).
- **Pool** (`pool.rs`): `claimed_plan_cell` :181-186; `RenderClaim` drop INVARIANT :253-265; `try_claim_render_lockfree` :480-504.
- **F82 heap transfer** (`crates/brust-server/src/actions.rs`): `take_fetch_body` :11-20 and `put_fetch_reply` :24-52 downcast the slot cell to `FetchCell`. `put_fetch_reply` returns `false` when `s.core.actions` is `None` (:25-27), and its cap is `actions.max_response_bytes`.
- **Native host** (`crates/brust-server/src/host.rs`): `NativeHost { pool, dist_dir, claim_timeout, call_timeout }` :28-33; impl :44-181. `start` (`server/mod.rs:122-150`) builds it and `Core::new`. `_pipeline_future_is_send` :104-108 asserts `Send` at compile time. `Config` (`config.rs:30-62`); `Server::invalidate`/`stats` :98-114.
- **napi** (`crates/brust-napi/src`): `kind_str` `dispatch.rs:57-63`; `StartOptions` `server.rs:146-168`; `start_server` :173-204; `take_fetch_body`/`put_fetch_reply` :259-274; `cache_invalidate` :316-329; `cache_stats` :332-336.
- **Worker** (`packages/brust/src/worker.ts`): `makeDispatch` :46-70 (`fetch` → `runFetch`; an unknown kind → `{error}`); `startWorker` :92-119 (actions set up from `manifest.actions` :104-109 before `registerWorker` :118). `run.ts`: `startOptions` :29-41 (keys from the manifest); the worker env :83-89 and `BRUST_WORKER_ID` :115. Main-thread `unhandledRejection` is fatal (:138-145).
- **TS seams**: `native.ts` `NativeBinding` :54-68 and `WorkerFn` :53; `cache.ts:11-23` `invalidate` → napi `cacheInvalidate`; `server-handlers.ts:10-26` `CfRuntime { invalidate }`, `install(runtime): void`, `installedRuntime()`; `actions-bridge.ts`: `HeapIo` :39-43, `writeFramed` :83-100, `runFetch` :144-173 (the model for `runCache`).
- **Build**: `build/config.ts`: `loadBuildConfig` :142-163; `parseActions` :103-138 is the pattern; `build/index.ts`: the actions entry is validated inside the app :105-121; `buildInto` :151-212 writes `manifest.actions` :185-188 and `manifest.json` :189; `build/bundle.ts`: `buildActions` :335-342 (`target: 'bun'`, `ACTIONS_EXTERNALS`); `build/manifest.ts`: `ManifestJson` :63-70; Rust `Manifest` (`manifest.rs:15-21`) has no `deny_unknown_fields`, so a new top-level key is ignored.
- **Cloudflare build** (`build/cloudflare.ts`): `cfNativeStub` :120-133 maps `cacheInvalidate` → `installedRuntime().invalidate`; every other name throws; The smoke preload :149-157 already stubs `cloudflare:workers` as `{ env: {}, waitUntil() {} }`; the smoke check is :158-168; CONFIG is built at :189-198; the bundle at :217-226 (`conditions ['workerd','worker','browser']`; `cfGuard` :84-95 rejects any `bun`/`bun:*` import); `build/cf-entry.ts`: `CfConfigJson` :3-12, `cfEntrySource` :25-47 (`export { install } …` :44). D3 snapshot: `tests/cf/entry.test.ts:10-13` vs `tests/fixtures/cf-min/cf/brust-app.entry.js`.
- **Wasm** (`crates/brust-wasm/src`): `lib.rs:5-18`: pure modules are host-built, JS ones wasm-only; `entry.rs`: `boot` :35-45 (`bridge::install(core)` last); `fetch(req, _env, _ctx)` :67-115; the stats gate :83-84. The guarded future `handled` :92-98 holds the e2e panic route (`BRUST_WASM_E2E`) before `core.handle`, inside `catch_unwind` :99; `bridge.rs`: `js_install(rt) -> Result<(), JsValue>` :38-39; `install` :64-77 builds `{ invalidate }`; `invalidate` :79-91; `host.rs`: `WasmHost { clock, replies, next }` :31-36, impl :65-181; `config.rs`: `CfConfig` `deny_unknown_fields` :9-26; `parse` :62.
- **Tests**: `crates/brust-server/tests/common/{mod.rs,fake_bun.rs}`: `FakeBun::reply` matches `CallKind` exhaustively (fake_bun.rs:234-238); its counters too (:302-306). It has one slot. `boot*` :104-139; `tests/server/harness.ts` is pokedex-only (`startPokedex`) and not this lane's; `tests/cf/tools.ts` pins `wrangler@4.149.0`; `tests/cf/cf-min.test.ts` shows the workerd spawn/readiness pattern; `ci.yml:166-176` lists `packages/brust` test files explicitly; `:89` runs all of `tests/cf`.
- **[PD1]** (merged at cfacdd3) `lane/m4cf-pokedex-d1` added `packages/brust/src/cf.ts` and `"workerd": "./src/cf.ts"` in the `"."` export of `packages/brust/package.json`. In the CF bundle, `cache` resolves to `./cache` → the stub → `rt.invalidate` (cae0132). This lane touches neither the `"."` entry nor `cf.ts`.

## Goal
- `@brust/core/cache-adapter` exports: the §3.1 types, with `GetResult.entryStamp` (L1 below); `memoryAdapter(opts?)`: a store with the exact stale-write guard, plus a push or pull broadcast with a ring of 1024 events / 1 MiB; `defineCacheAdapter`.
  `@brust/core/cache-adapter/conformance` exports `runConformance(make, caps)` (bun:test). The conformance suite is green against the memory adapter in both broadcast modes.
- `brust.toml [cache]` (spec §6) is parsed and validated at build. The build writes `manifest.cache` (native) and `CONFIG.cache` (Workers). `adapter = "custom"` loads the app's module (default export: an adapter or a factory). Built-in names resolve to the B/C packages, with an install hint when absent. With no `[cache]` table, `manifest.json`, `StartOptions`, the CF entry (D3 snapshot) and `/_brust/cache/stats` are byte-identical to today.
- **Native.** On an L1 MISS of a cacheable route, the pipeline makes one `CallKind::Cache` `get` bounded by `get_timeout_ms` (default 50), and fails open.
  - A hit is inserted into L1 under the request's read stamp and served with `x-brust-cache: HIT-L2`.
  - After a successful L1 insert, a fire-and-forget `set` carries the L2 read stamp. It is dropped when no slot is free.
  - `cache.invalidate` (JS) runs the tier-1 primitive, then `store.invalidate` + `broadcast.publish`.
  - Worker 0 subscribes and replays foreign events through the napi primitive `cacheInvalidate`. A seq gap clears tier 1.
- **Workers.** The generated entry passes the adapter to `install(rt, ext)`, and `install` returns the bridge. `WasmHost` implements `l2_get` (100 ms) and `l2_set` (JS `waitUntil`).
  - `crates/brust-wasm/src/epoch/` holds the pull cursor and the invalidation floor. It is polled at most once per `epoch_interval_ms`, single-flight with a 500 ms cap, inside the guarded future.
- `/_brust/cache/stats` gains `"l2": {…}` (spec §8 keys + `set_oversize`, R9) only when an adapter is configured.
- **The HIT path is untouched.** `get_with`, the probe block and `hit_response` diff empty (gates in Task 12). The no-adapter path adds two `Option` checks on the MISS path only.

**Lead rulings already folded in (2026-10-12, not re-asked):**
- **L1.** `GetResult` gains `entryStamp: number | null` (the entry's write stamp, kept by every store) beside `stamp` (the broadcast seq now). `L2Lookup::Hit` carries both, and the floor check uses `entryStamp`.
- **L2.** Write-through happens on any `Miss { stamp: Option }` and never on Failed/Off/Timeout. A `null` stamp is an unguarded write, so a broadcast-less store still writes. The §3.2 wording is amended (Task 13).
- **L3.** A replay never re-publishes. Native replays through napi `cacheInvalidate` and Workers through `core.invalidate`. The publish lives ONLY in the JS `cache.invalidate` wrapper. A unit case and an e2e case prove it.
- **L4.** This lane takes NO bench lock and runs NO bench (rule:bench-hold). Illenium measures S/D/I ≤ 3 % (two runs, no adapter) on the remote host as a runner task the lead schedules after READY.
- **L5.** No epoch code exists yet. This lane ships the cursor in `crates/brust-wasm/src/epoch/` plus the memory adapter's pull broadcast; the DO ring is lane C.
- **L6.** The epoch poll sits inside `entry.rs`'s guarded future (with the e2e panic route), after the stats gate.

## Rulings requested
**R1 — Native broadcast mode.** *Default:* native accepts **push only** (`subscribe`) in v1. On Bun, an adapter whose broadcast has only `since` makes worker boot fail with `cache adapter "<name>": native needs a push broadcast (subscribe); pull (since) is Workers-only in v1`. A store without a broadcast is allowed (its writes are unguarded). *Alternative:* port the cursor to TS and let worker 0 poll `since` natively (this covers the spec §5.4 "Upstash REST on Bun" example, at the cost of a second cursor implementation).

**R2 — `CallKind::Cache` op set.** *Default:* only `get` and `set` cross Rust → JS, served by any worker. `get` uses the normal claim inside `tokio::time::timeout(get_timeout)`. `set` claims with a zero wait (`claim_or_wait(.., Duration::ZERO, ..)` over `try_claim_render_lockfree`); `Timeout`/`NoWorkers` → `set_dropped`++. `invalidate`/`publish` originate in JS (the `cache.invalidate` wrapper, in the worker that ran the action) and never involve Rust. `subscribe` starts in JS at worker 0's boot.

*Alternative:* Rust-driven `invalidate`/`publish`/`subscribe-start` calls (an extra crossing for every mutation; no benefit, since the action already runs in a worker).

**R3 — Wire.** *Default:* the request is inline JSON (dispatch.rs:8-21):
- `{"op":"get","key":K}`;
- `{"op":"set","key":K,"status":200,"headers":[[k,v]…],"meta":{"ttlMs","tags","method","path","stamp"},"heap":N}`. The `set` body ALWAYS waits in the call's new `CacheCell { body, reply, cap }` for `takeFetchBody`, even when small (no base64).

The response is the A2 frame `[u32 LE meta_len][meta JSON][body]`:
- `get` hit: `{"hit":true,"status","headers","stamp","entryStamp","storedAt"}` with the body framed, or with `"heap":N` and the body via `putFetchReply` when it does not fit the slot;
- `get` miss: `{"hit":false,"stamp":S|null}`;
- `set`: `{"ok":bool}`;
- any failure: `{"error":"…"}`.

`take_fetch_body`/`put_fetch_reply` (actions.rs) accept a `CacheCell` too, with that cell's cap (`l2.max_body_bytes`). The `FetchCell` behaviour is unchanged. *Alternative:* an inline `{text|b64}` set body ≤ 256 KiB (+33 % size, a JSON escape pass).

**R4 — L2 body cap.** *Default:* `max_body_bytes` defaults to **1048576** (spec §6), range 1..=67108864.
- A larger rendered body is not written (`set_oversize`++).
- A larger `get` body is answered as a miss by the JS bridge (`{"hit":false}` + `errors`++).

*Alternative:* default = `actions.max_response_bytes` (8 MiB), as the task prompt suggests. With R4's default the Redis value stays small and KV's 25 MiB limit is never approached.

**R5 — Read-through scope.** *Default:* `l2_get` runs only when `s.l2.is_some() && cache_key.is_some()`, i.e. a route with `cache`, not bypassed. It runs after the stamp (:220) and before the loader, for GET and HEAD alike (HEAD shares entries). `l2_set` runs only when the L1 `insert` returned `true`, i.e. `store` was true: status 200, no set-cookie, no rejected job value. Bypass, uncached, 404 and redirect responses never touch L2. *Alternative:* none proposed. This is stated for the record.

**R6 — L1 TTL after a HIT-L2.** *Default:* the remaining TTL is `ttl − (now_wall_ms − storedAt)`, clamped to [1 s, ttl]. `storedAt` null → the full ttl. An entry already past its ttl → treated as a miss (`misses`++, and the request writes through). `now_wall_ms` is `SystemTime` natively and `Date.now()` on Workers, through a new `Clock::wall_ms()` default method (native override; `JsClock` uses `Date.now()`). *Alternative:* the full route ttl. That is simpler, but one L2 entry can then be served up to 2 × ttl.

**R7 — `build_id` and the key hash.** *Default:*
- `build_id` is computed by **the build**: the first 16 hex chars of sha256 (`Bun.CryptoHasher`) over the manifest JSON (without the `cache` block) + every `jinja/*.jinja` (sorted by name) + `jobs.js` + `actions.js` when present. It is written to `manifest.cache.buildId` and `CONFIG.cache.buildId`.
- Rust and the adapter's `init({ buildId })` read that one value.
- `L2Key = "<namespace>:<build_id>:p:" + hex(blake3(prefix ‖ 0 ‖ method ‖ 0 ‖ path ‖ 0 ‖ sorted_query))`. blake3 is already a dependency.

*Alternative:* the spec §3.2 text, i.e. Rust hashes at `Core::new` with sha256. That needs a `sha2` dependency, and `Loaded` keeps no raw manifest bytes (`manifest.rs:185-190`). Task 13 amends §3.2 to the ruled form.

**R8 — Config keys, custom loading, built-ins.** *Default:*
- The key is `module` (spec §6 as approved), not `adapter_module` (the task prompt's name; the alternative).
- `module` must be a file inside the app, with the same check as `actions.entry` (`build/index.ts:105-111`).
  - Native: it is bundled to `dist/cache-adapter.js` (`target: 'bun'`, `ACTIONS_EXTERNALS`), so `bun dist/index.js` works prebuilt.
  - Workers: the generated entry imports it by absolute path.
- The default export is a `CacheAdapter`, or a `CacheAdapterFactory` called with `[cache.options]`.
- Built-ins: the default export of each subpath is a factory. `redis` → `@brust/cache-redis`, `dragonfly` → `@brust/cache-redis/dragonfly`, `cloudflare-kv` → `@brust/cache-cloudflare/kv`, `cloudflare-do` → `@brust/cache-cloudflare/do`. This is the contract for lanes B and C.
  - Each is resolved with `Bun.resolveSync(spec, appRoot)`. A missing one → `BuildError('cache', 'adapter "redis" needs @brust/cache-redis (bun add @brust/cache-redis)')`.
  - `[cache.redis]` options go to redis/dragonfly; `[cache.cloudflare]` to kv/do.
  - `[cache.redis].url` must be `env:NAME` (anything else is a BuildError naming the key, never the value). Native resolves `env:` strings in built-in option tables from `process.env` at worker boot; on `--target cloudflare` an `env:` value is a BuildError.
- `broadcast = "<built-in>"` composes `{ ...adapter, broadcast: other.broadcast }`. It accepts built-in names only.
- There is **no `adapter = "memory"`**: per-Bun-worker memory would silently not share. Tests use `custom`.

**R9 — Metrics.** *Default:* the spec §8 keys in that order, plus `set_oversize` after `set_dropped`. Ownership:
- Rust counts the request-path fields.
- JS-side fields (`published`, `publish_errors`, `received`, `skipped_own`; on Workers also `sets`/`set_refused`) arrive through napi `cacheL2Count(name) -> bool` (native) / `rt.l2Count(name)` (Workers, routed by the CF native stub). They land in one `Arc<L2Counters>` in `Core`, so Rust serves one object per process (native) or per isolate (Workers).
- napi `cacheClear() -> u32` (native gap reset) bumps `resets` in Rust.

*Alternative:* the spec text "worker 0 reports through `cacheStats`" (that function only reads; it cannot report). A second alternative is to fold oversize into `set_dropped`.

**R10 — Native gap detection.** *Default:* worker 0's subscriber keeps `lastSeq`:
- first event → adopt;
- `seq ≤ lastSeq` → ignore;
- `seq > lastSeq + 1` → `cacheClear()`, then adopt;
- adapter `onGap()` → `cacheClear()` and forget `lastSeq`.

Own events are delivered and advance `lastSeq` but are not replayed. There is no 10 s reconciliation timer in this lane: a lost LAST event is undetected until the next one, so staleness stays ≤ ttl (documented). *Alternative:* a 10 s timer comparing `store.get(<probe key>).stamp` to `lastSeq` (one extra get per 10 s per process).

**R11 — Workers deferral.** *Default:* the generated entry (adapter configured only) imports `waitUntil` from `cloudflare:workers` and passes it to `install`. The JS bridge's `set` and the `cache.invalidate` wrapper's store/publish run under it. Rust's `l2_set` is fire-and-forget (it calls the JS `set`, which defers itself). *Alternative:* Rust `ctx.wait_until` through a per-request cell set in `entry.rs` (spec §3.4). That means more Rust plumbing for the same effect.

**R12 — Native two-process e2e transport.** *Default:* `tests/server/l2-relay.ts` is a Bun.serve relay spawned by the test. It hosts ONE `memoryAdapter({ broadcast: 'push' })`:
- HTTP `POST /get|/set|/invalidate|/publish` (bodies base64 in JSON);
- WebSocket `/sub` for push;
- `GET /stats` (publish count);
- `POST /hang-next-get`.

The fixture's custom module is a relay client. *Alternative:* skip the native e2e here and rely on lane B's Redis e2e (the native path would then first be proven end to end only in lane B).

**R13 — CONFIG abi.** *Default:* `abi` stays 1. `CfConfig` gains an optional `cache: { adapter, getTimeoutMs, maxBodyBytes, namespace, buildId, epochIntervalMs }` (serde default `None`). `@brust/core-cf` is unpublished, and both land together on m4cf. *Alternative:* abi 2.

**R14 — Workers adapter validation.** *Default:* `server-handlers.install(rt, ext)` throws a `TypeError` (→ boot error, lane-3 R11) when:
- `runtimes` lacks `'workers'`;
- the broadcast is push-only;
- `CONFIG.cache` and `ext.adapter` disagree.

The build smoke (`cloudflare.ts:158-168`) calls `install` with a fake `rt` when `CONFIG.cache` is set, so these errors surface at `brust build`. *Alternative:* start-time only.

**R15 — Subpath split.** *Default:* two exports.
- `"./cache-adapter": "./src/cache-adapter/index.ts"`: types, `memoryAdapter`, `defineCacheAdapter`. No `bun`/`bun:*` import, so it is safe inside the CF bundle (`cfGuard`).
- `"./cache-adapter/conformance": "./src/cache-adapter/conformance.ts"`: imports `bun:test`.

*Alternative:* one subpath (the spec §7 wording). This breaks any Workers app that imports it.

**R16 — CI lines.** *Default:* this lane adds `run:` lines to `.github/workflows/ci.yml` for its new `packages/brust` test files and `tests/server/cache-adapter.test.ts`, and nothing else. Lane B later adds its service containers to the same file and rebases over these lines. *Alternative:* the lead adds the lines at merge.

## Boundary
- **Rust core:** `crates/brust-core/src/{l2.rs (new), lib.rs, host.rs, core.rs, config.rs, pipeline.rs, protocol.rs}`; `crates/brust-core/src/cache/local.rs` (the two `clear_all` trait impls only).
- **Rust native:** `crates/brust-server/src/{dispatch.rs, host.rs, actions.rs, config.rs, lib.rs, server/mod.rs, cache/mod.rs (trait forwarders only)}`, `crates/brust-server/tests/{common/**, l2.rs (new)}`. Also `crates/brust-napi/src/{dispatch.rs, server.rs}`.
- **Rust Workers:** `crates/brust-wasm/src/{lib.rs, bridge.rs, entry.rs, host.rs, config.rs}`, `crates/brust-wasm/src/epoch/{mod.rs, cursor.rs, floor.rs, sync.rs}` (new).
- **TS:**
  - `packages/brust/package.json`: only the two R15 `exports` lines.
  - `packages/brust/src/{cache-adapter/** (new), cache.ts, native.ts, worker.ts, run.ts, server-handlers.ts}`.
  - `packages/brust/src/build/{config.ts, index.ts, manifest.ts, bundle.ts, cf-entry.ts, cloudflare.ts}`.
  - `packages/brust/test/{cache-adapter-memory, cache-adapter-bridge, cache-adapter-runtime, build-config-cache, build-cache}.test.ts` (new), plus `run-options.test.ts`, `cf-entry.test.ts`, `cf-build.test.ts` (added cases only).
- **E2E:** `tests/server/{cache-adapter.test.ts, l2-relay.ts}` (new); `tests/fixtures/l2-relay/**` and `tests/fixtures/cf-l2/**` (new workspace members); root `package.json` (`workspaces` +2) and `bun.lock` (those members only); `tests/cf/cache-adapter.test.ts` (new).
- **Other:** `bench/attribution.patch` (regenerated); `.github/workflows/ci.yml` (R16 lines only); `docs/design/2026-10-12-cache-adapter-design.md` (Task 13 amendments).
- **NOT in the boundary:**
  - `crates/brust-server/src/cache/{l1.rs,job_cache.rs}` (the HIT path);
  - `packages/brust/src/{cf.ts, index.ts, actions-bridge.ts, handlers.ts}` and the `"."` export ([PD1]);
  - `packages/brust/src/build/cf-wrangler.ts` (lane C);
  - `tests/fixtures/cf-min/**`, `tests/cf/{cf-min,entry}.test.ts` (D3), `tests/server/harness.ts`, `examples/**`, `packages/cache-*` (lanes B/C), `bench/**` except the patch.
  - Anything else → `conclave task challenge`.

## Tasks
Use `W=/Users/detoro/code/brust-lane-cache-adapter-core`, `OUT=/private/tmp/cache-adapter-core` (never committed), `WS=838f12fb-70c1-41b7-acf2-d4065cf6bb64`. `CLIPPY` = `cargo clippy -p brust-core -p brust-compiler -p brust-compiler-cli -p brust-jinja -p brust-server -p brust-napi -p brust-wasm --no-deps -- -D warnings && cargo clippy -p brust-wasm --target wasm32-unknown-unknown --no-deps -- -D warnings`.

Every Rust task ends with `cargo fmt --all -- --check`, CLIPPY, and the named tests. After a Rust edit, run `(cd packages/brust && bun run build:debug)` before any JS test (stale addon trap). Commit per task with the Co-Authored-By trailer.

### Task 1 — worktree, base, baselines
- [ ] `git -C /Users/detoro/code/brust fetch origin && git -C /Users/detoro/code/brust worktree add $W -b lane/cache-adapter-core origin/m4cf && cd $W && git log --oneline -1`. `git log --oneline --grep 'merge: lane/m4cf-pokedex-d1' | wc -l` → 1 and `test -f packages/brust/src/cf.ts && echo PD1` → `PD1` (else challenge: wrong base).
- [ ] `bun install --frozen-lockfile && (cd packages/brust && bun run build:debug)` → exit 0.
- [ ] `mkdir -p $OUT && cargo test --workspace --exclude bun_react_compiler 2>&1 | tee $OUT/t1.txt | grep -c '^test result: ok'`; `grep -c FAILED $OUT/t1.txt` → 0.
- [ ] `(cd packages/brust && bun test 2>&1 | tail -3)` → 0 fail. `bun test --timeout 120000 tests/server/pokedex.test.ts` → 0 fail. `BRUST_CF_E2E=1 bun test --timeout 900000 tests/cf 2>&1 | tail -3 | tee $OUT/cf-before.txt` → 0 fail. `git apply --check bench/attribution.patch` → exit 0.
- [ ] Save the HIT-path baselines from `origin/m4cf`:
  - `git show origin/m4cf:crates/brust-server/src/cache/l1.rs | sed -n '/pub fn get_with/,/^    }$/p' > $OUT/getwith.before`;
  - `git show origin/m4cf:crates/brust-core/src/pipeline.rs | sed -n '/let hit = s.l1.get_with/,/hit_response(&b, gz));/p' > $OUT/probe.before`;
  - `… | sed -n '/^fn hit_response/,/^}/p' > $OUT/hitresp.before`.

### Task 2 — core: L2 types, counters, stats, clear (no pipeline change yet)
- [ ] **Tests first** in `crates/brust-core/src/l2.rs` `mod tests`:
  - `l2_key_is_namespaced_and_stable`: `L2Key::of(&cfg("ns","b1"), &key("", "GET", "/a", "x=1"))` starts with `ns:b1:p:`, has 64 hex chars after it, and differs for a different `prefix`/`sorted_query`;
  - `l2_page_drops_per_request_headers`: pairs `[content-type, x-brust-cache, content-encoding, vary, content-length, transfer-encoding, set-cookie, x-app]` → the RenderedBody keeps `content-type` and `x-app` only. An invalid name or value is skipped;
  - `pairs_round_trip_order_and_repeats`: a HeaderMap with two `x-a` values → pairs in order;
  - `counters_bump_by_name`: `bump("published")` → true; `bump("nope")` → false;
  - `l2_stats_shape`: `serde_json::to_string(&counters.snapshot("custom"))` == `{"adapter":"custom","hits":0,"misses":0,"timeouts":0,"errors":0,"rejected_floor":0,"sets":0,"set_refused":0,"set_dropped":0,"set_oversize":0,"published":0,"publish_errors":0,"received":0,"skipped_own":0,"resets":0,"epoch_polls":0,"poll_errors":0}`;
  - `remaining_ttl_clamps` (R6): age 0 → ttl; age > ttl → `None`; age ttl−0.5 s → 1 s.
- [ ] **Tests first** in `config.rs` tests:
  - `stats_json_shape_is_stable` gets `l2: None` in its literal. That is the only edit to an existing assertion, and the expected string is unchanged;
  - `stats_with_l2_appends_the_object`: the same + `,"l2":{"adapter":"custom",…}}`;
  - `invalidate_args_serialize_skips_empty`: `{tags:["a"], path:"/x"}` → `{"tags":["a"],"path":"/x"}`, and it round-trips `==`.
- [ ] Implement `l2.rs`. The R6 helper is `pub fn remaining_ttl(ttl: Duration, stored_at_ms: Option<u64>, now_ms: u64) -> Option<Duration>`. The types:
  ```rust
  pub struct L2Config { pub adapter: String, pub get_timeout: Duration, pub max_body_bytes: usize, pub namespace: String, pub build_id: String }
  pub struct L2Key(pub String);                                   // L2Key::of(&L2Config, &CacheKey) (R7, blake3)
  pub struct L2Probe<'a> { pub key: &'a L2Key, pub path: &'a str, pub tags: &'a [String] }
  pub struct L2Page { pub status: u16, pub headers: Vec<(String, String)>, pub body: Bytes }
  pub struct L2SetMeta { pub ttl_ms: u64, pub tags: Vec<String>, pub method: String, pub path: String, pub stamp: Option<u64> }
  pub enum L2Lookup { Off, Miss { stamp: Option<u64> }, Floor { stamp: Option<u64> },
                      Hit { page: L2Page, stamp: Option<u64>, entry_stamp: Option<u64>, stored_at_ms: Option<u64> },
                      Timeout, Failed(String) }
  #[derive(Default)] pub struct L2Counters { /* one AtomicU64 per §8 key + set_oversize */ }
  #[derive(Serialize)] pub struct L2Stats { pub adapter: String, /* u64 fields in R9 order */ }
  ```
  `config.rs`:
  - `InvalidateArgs` derives `Clone, PartialEq, Serialize` with `skip_serializing_if` on the empty/`None` fields;
  - `Stats` gains `#[serde(skip_serializing_if = "Option::is_none")] pub l2: Option<L2Stats>` LAST.
- [ ] `host.rs`:
  - `PageCache` gains `fn clear_all(&self) -> usize;` and `JobStore` gains `fn clear_all(&self);`. They are named `clear_all` so they never collide with the inherent `clear` and `ConformL1::clear`.
  - `Clock` gains `fn wall_ms(&self) -> u64 { 0 }`.
  - `Host` gains the two defaults:
  ```rust
  fn l2_get(&self, _p: &L2Probe<'_>) -> impl Future<Output = L2Lookup> { async { L2Lookup::Off } }
  fn l2_set(&self, _key: L2Key, _page: L2Page, _meta: L2SetMeta, _counters: &Arc<L2Counters>) {}
  ```
  The forwarders go in `brust-server/src/cache/mod.rs` (→ the inherent `clear`) and `local.rs`.
- [ ] `core.rs`:
  - `CoreConfig.l2: Option<L2Config>`;
  - `Core` fields `#[doc(hidden)] pub l2: Option<L2Config>` and `pub(crate) l2_counters: Arc<L2Counters>`;
  - `pub fn l2_count(&self, name: &str) -> bool`;
  - `pub fn clear_local(&self) -> usize` (`l1.clear_all()` + `jobs.clear_all()`; `resets`++ when `l2` is set);
  - `stats()` fills `l2`.
  Native `Config` gains `l2: Option<L2Config>` (default `None`), passed in `server/mod.rs` `start`.
- [ ] `cargo test -p brust-core -p brust-server` → green; the `config` tests pass; the brust-server count equals t1's. Commit `feat(core): L2 contract types, counters, stats.l2, clear_all (cache-adapter A)`.

### Task 3 — core pipeline hooks (R5, R6, L2)
- [ ] `CacheOutcome` gains `HitL2` (Display `"HIT-L2"`). Add `fn l2_hit_response(b: &RenderedBody, gz: bool) -> Response<Bytes>` = `hit_response`'s body with `Some("HIT-L2")`. `hit_response` itself is NOT edited.
- [ ] After :220, add:
  ```rust
  let mut l2_write: Option<(L2Key, Option<u64>)> = None;
  if let (Some(l2), Some(k), Some(c)) = (&s.l2, &cache_key, &route.cache) { … }
  ```
  - Build the key, then match `s.host.l2_get(&L2Probe { key: &key, path: path_of(full), tags: &c.tags }).await`:
    - `Hit` → `page_from_l2` + `remaining_ttl(Duration::from_secs(c.ttl_seconds), stored_at_ms, s.host.wall_ms())`. Both `Some` → `hits`++, `s.l1.insert(k.clone(), Arc::clone(&b), ttl, &c.tags, since)` (a refused insert still serves), `meta.cache = HitL2`, return `l2_hit_response`. Malformed → `errors`++; expired → `misses`++ and `l2_write = Some((key, stamp))`.
    - `Miss{stamp}` → `misses`++, `l2_write = Some((key, stamp))`.
    - `Floor{stamp}` → `rejected_floor`++, `l2_write = Some((key, stamp))`.
    - `Timeout` → `timeouts`++.
    - `Failed(e)` → `errors`++ and `tracing::debug!(target: "brust::cache", …)`.
    - `Off` → nothing.
- [ ] The store block (:471-480) keeps its exact shape when `l2_write` is `None`. With `Some`, clone the `Arc` before the move. After `insert` returned `true`:
  - `html.len() > max_body_bytes` → `set_oversize`++;
  - else `s.host.l2_set(key, L2Page { status, headers: pairs_of(&b.headers), body: b.html.clone() }, L2SetMeta { ttl_ms: ttl*1000, tags: c.tags.clone(), method: "GET", path, stamp }, &s.l2_counters)`.
- [ ] `cargo test -p brust-core -p brust-server` → the t1 counts. `rg -n 'HitL2|l2_' crates/brust-core/src/pipeline.rs | wc -l` → the expected number of hunks. Commit.

### Task 4 — native wire, host and HTTP tests (R2, R3, R4)
- [ ] **Tests first** in `crates/brust-server/tests/l2.rs` (`mod common;`). Extend `FakeBun`: `CallKind::Cache` arms in `reply`/`call` and a `cache: Mutex<FakeL2>`, an in-test map with an exact stale-guard (`last_inval_seq` per tag), plus `hang_next_get`, `fail_next`, `cache_calls()`, and `last_cache()`. Add `common::boot_l2(fake, L2Config)`. Cases:
  1. `miss_then_hit_l2_on_a_second_server`: two servers share one `FakeL2`. GET `/pokemon/pikachu` on A → `MISS`; poll ≤ 2 s for `cache_calls` showing a `set`; GET on B → `HIT-L2`, B `loader_calls` 0; GET on B → `HIT`.
  2. `get_timeout_renders`: `hang_next_get` + `get_timeout` 50 ms → `MISS` within 2 s, 200 OK, stats `l2.timeouts` 1, and no set (`last_cache().op == "get"`).
  3. `stale_set_is_refused`: get returns stamp 5; before the set, the test invalidates tag `pokemon` at seq 6 in `FakeL2`; the set → `{"ok":false}` → `set_refused` 1; B's next GET → `MISS`.
  4. `set_dropped_when_the_slot_is_busy`: this is a dispatch unit test in `dispatch.rs` `mod tests` (FakeBun has one slot, so an HTTP-level version cannot hold the slot while a page completes). Use the existing gated pool helper (`gated_pool` :1009). Claim the only slot with a parked call, then `call_worker_cache_set(&pool, Duration::ZERO, …)` → `Err(CallError::Timeout)` within 100 ms. Pair it with a `NativeHost` unit test where `l2_set` on that pool → `set_dropped` 1 once the spawned task finishes (poll the counter ≤ 1 s).
  5. `oversize_body_is_not_written`: `sized_dist` page > `max_body_bytes` (set to 1024) → `set_oversize` 1.
  6. `heap_reply_for_a_large_hit`: a FakeL2 body of 300 000 bytes is served by `putFetchReply` (the FakeBun calls `brust_server::put_fetch_reply`) → `HIT-L2`, body equal.
  7. `bypass_and_uncached_routes_never_call_l2`: `/tenant` with the bypass cookie and an uncached route → `cache_calls` 0.
  8. `no_adapter_is_byte_identical`: without `l2`, the stats JSON has no `"l2"` and `cache_hdr` is MISS/HIT exactly as in `l1_front.rs`.
  9. `failed_get_is_fail_open`: `fail_next` → `{"error"}` frame → 200 MISS, `errors` 1.
- [ ] Implement:
  - `CallKind::Cache` (dispatch.rs :44);
  - core `protocol.rs` `CacheRequest<'a>` (`#[serde(tag = "op", rename_all = "lowercase")]`) and `CacheReplyMeta`;
  - dispatch.rs `pub struct CacheCell { pub(crate) body, pub(crate) reply, pub(crate) cap: usize }`, `call_worker_cache_get(pool, claim_t, call_t, key, cap) -> Result<L2Lookup, CallError>` and `call_worker_cache_set(…) -> Result<bool, CallError>` over `call_worker_decoded`, with `decode_cache_reply` modelled on `decode_fetch_reply` :279-305;
  - `actions.rs`: `take_fetch_body`/`put_fetch_reply` also accept `CacheCell`. The copy guard uses `max(actions cap, l2 cap)`, and the exact cap check is inside the lock per cell type. A fetch cell's behaviour is unchanged (the existing `actions.rs` tests stay green);
  - `NativeHost` gains `l2: Option<(Duration, usize)>`. `l2_get` = `tokio::time::timeout(get_timeout, call_worker_cache_get(..))`, mapped to `L2Lookup`. `l2_set` = `tokio::spawn` of `call_worker_cache_set(pool, Duration::ZERO, call_timeout, ..)`: `Timeout|NoWorkers` → `set_dropped`, `Ok(true)` → `sets`, `Ok(false)` → `set_refused`, `Err` → `errors`. `wall_ms` = `SystemTime`.
- [ ] `cargo test -p brust-server --test l2` → 9 passed; `cargo test -p brust-server` → green; `cargo build -p brust-server` proves `_pipeline_future_is_send` still holds. Commit.

### Task 5 — napi
- [ ] Add:
  - `StartOptions.l2: Option<NapiL2Options { adapter: String, get_timeout_ms: Option<u32>, max_body_bytes: Option<u32>, namespace: String, build_id: String }>` (defaults 50 / 1048576; camelCase on the JS side);
  - `kind_str` `CallKind::Cache => "cache"`;
  - `#[napi] fn cache_l2_count(name: String) -> bool` (never throws; `false` without a server);
  - `#[napi] fn cache_clear() -> napi::Result<u32>`.
  Unit test `l2_options_default` mirrors `actions_options_default` (:405-430).
- [ ] `native.ts`: `L2Options`, `StartOptions.l2?`, `WorkerFn` kind `| 'cache'`, the `cacheL2Count`/`cacheClear` bindings and exports. `cargo test -p brust-napi`; `(cd packages/brust && bun run build:debug && bun test test/napi-server.test.ts)` → green. Commit.

### Task 6 — `@brust/core/cache-adapter`: types, memory adapter, conformance (R15, L1, L5)
- [ ] `src/cache-adapter/types.ts`: spec §3.1 verbatim plus `GetResult.entryStamp: number | null` and `SetMeta.stamp: number | null`. `InvalidateArgs` is re-exported from `../native` (type only).
- [ ] `src/cache-adapter/memory.ts`: `memoryAdapter(o?: { broadcast?: 'push' | 'pull' | 'none'; ring?: number; ringBytes?: number; maxBodyBytes?: number; now?: () => number })` with defaults push / 1024 / 1048576 / 8388608 / `Date.now`.
  - The store maps key → `{page, meta, entryStamp, storedAt, expiresAt}` and keeps per-tag and per-`method path` last-invalidation seqs.
  - `set` refuses when `meta.stamp !== null` and any of its tag/path seqs > stamp, and when `body.length > maxBodyBytes`.
  - `invalidate` deletes by tag/path (`key` → no-op) and bumps those seqs only through `publish` (one seq space).
  - pull: `since(seq)` returns `{gen, seq, behind, events}` (ring by count and bytes, oversize event → a `behind` marker).
  - push: `subscribe(on, onGap)` → an unsubscribe fn.
  - Test hooks under `__test`: `regen()`, `hangNextGet()`, `failNext()`, `publishCount()`.
  - It has no `bun` import. `src/cache-adapter/index.ts` re-exports types, `memoryAdapter`, and `defineCacheAdapter = <T extends CacheAdapter | CacheAdapterFactory>(a: T) => a`.
- [ ] `src/cache-adapter/conformance.ts`: `runConformance(make: () => CacheAdapter | Promise<CacheAdapter>, caps: { push?: boolean; pull?: boolean; guard?: boolean })` registers `describe('cache adapter conformance: <name>')` with these cases (each a fresh `make()`):
  - get miss (`page: null`); set → get round trip (status, headers order + repeats, body);
  - all 256 byte values; `entryStamp` round trip;
  - ttl expiry (`ttlMs: 1`, polled ≤ 2 s); tag invalidation keeps unrelated keys; path+method invalidation; `key` invalidation is a no-op;
  - stale stamp refused (`guard`); `maxBodyBytes` refused;
  - `publish` seqs strictly increase and `get().stamp` equals the last seq (one space);
  - push: in-order delivery with `origin` + `args`; unsubscribe stops delivery;
  - pull: contiguity `since(0)` after 3 publishes; `behind` after overflow.
- [ ] **Tests** `packages/brust/test/cache-adapter-memory.test.ts`:
  - `runConformance(() => memoryAdapter({broadcast:'push'}), {push:true, guard:true})`;
  - the same for pull;
  - memory-only: `regen` changes `gen`; the 1 MiB ring drops the oldest; an oversize event → `behind`.
  `(cd packages/brust && bun test test/cache-adapter-memory.test.ts && bun run typecheck)` → green; `rg -n "from 'bun" src/cache-adapter/{index,types,memory}.ts` → empty. Commit.

### Task 7 — native worker bridge, runtime wrapper, worker-0 subscriber (R1, R9, R10, L3)
- [ ] `src/cache-adapter/runtime.ts` (no `bun` import):
  - `setCacheRuntime({ adapter, origin, defer, count } | null)`;
  - `afterInvalidate(args)`: only when the adapter has a store or a broadcast. `defer(Promise.allSettled([store?.invalidate(args), broadcast?.publish(args, origin)]))`; a fulfilled publish → `count('published')`, a rejection → `count('publish_errors')` + `console.error` with no option values.
  - `cache.ts` `invalidate` calls the primitive first (unchanged), then `afterInvalidate(args)`, and returns the primitive's result. The native `defer` = `(p) => void p.catch(() => {})`.
- [ ] `src/cache-adapter/bridge.ts` `runCache(requestJson, view, slot, slots, io: HeapIo, deps)`. It never rejects and always writes a frame.
  - `get` races `store.get` with `setTimeout(getTimeoutMs)`. Then: miss → `{hit:false, stamp}`; hit ≤ cap → a framed body, or `heap` + `io.putReply`; over cap → `{hit:false}` + error.
  - `set` takes `io.takeBody(slot)` (length must equal `heap`) and races `store.set` with 5 s → `{ok}`.
  - Errors → `{error}`.
  - `worker.ts` `makeDispatch` gains `if (kind === 'cache') return runCache(…)` next to `fetch` (:48).
- [ ] `src/cache-adapter/load.ts`: `loadAdapter(manifestCache, dist)` imports `join(dist, module)` (custom) or the built-in spec, calls the factory with options (resolving `env:` for built-ins, R8), validates the shape, and enforces R1 for `runtime: 'bun'`. `startWorker` (before `registerWorker`, like actions :104-109) loads it, awaits `init({ namespace, buildId, runtime: 'bun', workerId })`, and calls `setCacheRuntime`. When `BRUST_WORKER_ID === '0'`, `startSubscriber(adapter, origin, { invalidate: cacheInvalidate, clear: cacheClear, count: cacheL2Count })` runs after `registerWorker` (R10 rules; foreign → `invalidate(args)` + `received`; own → `skipped_own`).
  - `run.ts` sets `BRUST_CACHE_ORIGIN = crypto.randomUUID()` in the worker env (:83-89).
- [ ] **Tests first**:
  - `packages/brust/test/cache-adapter-bridge.test.ts`, modelled on `actions-bridge.test.ts`: frames for hit/miss/heap/oversize/timeout/error/set-ok/set-refused/body-length-mismatch.
  - `packages/brust/test/cache-adapter-runtime.test.ts` with fake deps:
    - **`a replayed event is never re-published`** (L3): the subscriber receives a foreign event → `invalidate` called once and `publish` 0 times;
    - `cache.invalidate` → the primitive once + `publish` once with this origin;
    - own echo → `skipped_own` and no invalidate;
    - seq jump → `clear` once; `onGap` → `clear`;
    - a rejected publish → `publish_errors` and no unhandled rejection (`process.on('unhandledRejection')` spy stays empty).
  `bun test test/cache-adapter-bridge.test.ts test/cache-adapter-runtime.test.ts test/worker.test.ts test/cache.test.ts` → green. Commit.

### Task 8 — `[cache]` config, build output, `StartOptions.l2` (R4, R7, R8)
- [ ] **Tests first**:
  - `packages/brust/test/build-config-cache.test.ts`:
    - no table → `cache: null`;
    - `adapter = "custom"` without `module` → BuildError `cache.module is required for adapter "custom"`;
    - an unknown adapter → BuildError listing the five names;
    - `get_timeout_ms` 0/1001 → range error (1..=1000);
    - `epoch_interval_ms` 249/60001 → range error;
    - `max_body_bytes` 0/67108865 → range error;
    - an unknown key in `[cache]` → BuildError;
    - `[cache.redis] url = "redis://u:p@h"` → BuildError that does NOT contain `u:p`;
    - `module = "../x.ts"` → BuildError `not a file inside the app`;
    - `adapter = "redis"` without the package → the install hint;
    - namespace defaults to the package.json `name`, else `brust`.
  - `packages/brust/test/build-cache.test.ts` builds a temp app with `custom`:
    - `dist/cache-adapter.js` exists;
    - `manifest.cache` = `{adapter:"custom", module:"cache-adapter.js", options:{…}, namespace, getTimeoutMs:50, maxBodyBytes:1048576, epochIntervalMs:1000, buildId:/^[0-9a-f]{16}$/}`;
    - rebuilding unchanged gives the same `buildId`; editing a component changes it;
    - an app without `[cache]` has no `cache` key in `manifest.json`.
  - `run-options.test.ts`: `manifest.cache` → `l2: {adapter, getTimeoutMs, maxBodyBytes, namespace, buildId}`; no `cache` → exactly today's keys (the existing first test unchanged).
- [ ] Implement `parseCache` in `build/config.ts` (pattern :103-138), the `module` check in `build/index.ts` beside :105-121, `buildCacheAdapter` in `bundle.ts` beside `buildActions`, `ManifestJson.cache?`, `computeBuildId(out)` (R7) in `buildInto` after :188, and `run.ts` `startOptions` `l2`. `(cd packages/brust && bun test test/build-config-cache.test.ts test/build-cache.test.ts test/run-options.test.ts test/build-manifest.test.ts && bun run typecheck)` → green. Commit.

### Task 9 — Workers: CONFIG, install bridge, WasmHost L2, epoch cursor + floor (R11, R13, R14, L5, L6)
- [ ] **Tests first** (host-built, `crates/brust-wasm/src/epoch/cursor.rs` + `floor.rs`, pure). The cursor is `Cursor { origin, gen: Option<String>, seq, last_poll_ms, in_flight }`; `apply(&mut self, r: SinceResp) -> Plan::{Adopt, Replay(Vec<(u64, InvalidateArgs)>, skipped_own: u32), Clear}`; constants `MAX_REPLAY = 4096`, `POLL_TIMEOUT_MS = 500`. Cases (from the epoch-hook draft R7):
  - `due_only_after_interval_and_never_in_flight`;
  - `first_contact_adopts_without_replay`;
  - `replays_foreign_events_in_order`;
  - `skips_own_origin`;
  - `gen_change_clears`;
  - `behind_clears`;
  - `seq_regression_clears`;
  - `non_contiguous_seqs_clear` (seqs 4,6 for a jump of 3);
  - `over_max_replay_clears`;
  - `failure_keeps_seq_moves_last_poll`;
  - `parse_rejects_missing_fields_and_seq_over_2_53`.

  The floor is `Floor` (an LRU of 4096 names → seq; `global: Option<u64>`). Cases:
  - `replay_raises_tag_and_path_floors`;
  - `hit_below_a_tag_floor_is_rejected`;
  - `entry_stamp_none_is_never_rejected`;
  - `clear_same_gen_sets_global_floor`;
  - `clear_on_gen_change_resets_everything`;
  - `lru_evicts_oldest_name`.
- [ ] **Tests first** `crates/brust-wasm/src/config.rs`:
  - no `cache` → `None`;
  - `cache` with all fields → `L2Config` + `EpochCfg { interval_ms }`;
  - `getTimeoutMs` 0 → Err naming it;
  - an unknown key inside `cache` → Err.
  `parse` returns `(CoreConfig, bool, Option<EpochCfg>)`.
- [ ] Implement:
  - `bridge.rs`: `js_install(rt) -> Result<JsValue, JsValue>`. `rt` gains `l2Count(name)` (→ `core.l2_count`). The returned `{ cache?: { get, set, since?, origin } }` → `CacheBridge` stored in `WasmHost` (`RefCell<Option<CacheBridge>>`). `CONFIG.cache` present without a bridge (or the reverse) → boot Err.
  - `host.rs`:
    - `l2_get`: `get.call1(key)` → `select(JsFuture, worker::Delay::from(get_timeout))` → `Reflect` fields → `L2Lookup`. The floor check → `Floor`.
    - `l2_set`: `set.call(..)` (JS defers via `waitUntil`); a thrown error → `errors`.
    - `wall_ms` = `Date.now()`.
  - `epoch/sync.rs` `maybe_sync(core)`: when the bridge has `since`, the cursor is due and not in flight. Release every `RefCell` borrow before the await. Race the 500 ms cap. Then `Replay` → `core.invalidate(args)` per foreign event + floor update + `received`/`skipped_own`; `Clear` → `core.clear_local()` + floor clear. Count `epoch_polls`/`poll_errors`.
  - `entry.rs`: inside `handled` (:92-98), after the e2e panic line, `if method == "GET" || method == "HEAD" { epoch::sync::maybe_sync(core).await }`. In the e2e build only, also `/__brust_e2e/l1-clear` → `core.clear_local()` → 204, beside the panic route.
- [ ] TS:
  - `server-handlers.ts` `install(runtime, ext?: { adapter, options, config, waitUntil }): { cache: CacheBridgeJs | null }`. It enforces R14 and wires `setCacheRuntime` with `defer = waitUntil` and `count = rt.l2Count`; its `origin` is `crypto.randomUUID()`.
  - `cf-entry.ts`: `CfConfigJson.cache?` and `CfEntryInput.cache: { importLine, … } | null`. With `null` the output is byte-identical; with a value it replaces :44 with the import of the adapter, `import { waitUntil } from "cloudflare:workers"`, and `export const install = (rt) => installRuntime(rt, { adapter: CACHE, options: <json>, config: <json>, waitUntil })`.
  - `cloudflare.ts`: CONFIG `cache`; the stub list (:121) + `cacheL2Count: (n) => installedRuntime().l2Count(n)`; the smoke check calls `install(fakeRt)` when `CONFIG.cache` is set.
- [ ] **Tests:**
  - `cf-entry.test.ts`: no cache → equal to today (the D3 test in `tests/cf/entry.test.ts` stays green); with cache → contains the three lines and not the re-export line.
  - `cf-build.test.ts`: a push-only custom adapter → BuildError from the smoke check naming `push-only`; `runtimes: ['bun']` → BuildError.
  - `cargo test -p brust-wasm` → +17; wasm clippy 0; `bun crates/brust-wasm/scripts/build.ts --e2e --out $OUT/w` → exit 0 and lane 3's < 4 MiB bar holds (record before → after). Commit.

### Task 10 — native two-process e2e (R12)
- [ ] Add the fixture `tests/fixtures/l2-relay/`:
  - `package.json` `@brust/fixture-l2-relay` (deps as cf-min) → root `workspaces` + `bun install` → `bun.lock` gains only this member;
  - `routes.tsx`: `/items/{id}` loader `{id, n: Date.now()}`, `cache: { ttl_seconds: 600, tags: ['items'] }`, and `/plain/{id}` uncached;
  - `actions.ts` `POST /bump {tag}` → `cache.invalidate({tags:[tag]})`;
  - `cache.ts`: a default-exported factory → `relayAdapter(process.env.BRUST_L2_RELAY!)` from `lib/relay-client.ts` (fetch + WebSocket subscribe; `runtimes: ['bun']`);
  - `brust.toml`: `[actions]`; `[cache] adapter = "custom"`, `module = "cache.ts"`, `namespace = "l2e2e"`, `get_timeout_ms = 200` (generous for CI).
  - **No root `input.tsx`** (the compiler golden-dir trap).
- [ ] `tests/server/l2-relay.ts`: R12. It prints `listening <port>` and owns one `memoryAdapter({broadcast:'push'})`.
- [ ] `tests/server/cache-adapter.test.ts` spawns the relay, builds the fixture once, and starts A and B (`bin/brust start --port 0 --workers 2`, env `BRUST_L2_RELAY`), copying `startPokedex`'s readiness loop. It kills only its own PIDs in `afterAll`.
  1. A `/items/7` → MISS; poll B ≤ 2 s → `HIT-L2` with A's `n`; B again → `HIT`; B stats `l2.hits` ≥ 1, `loader_calls` 0.
  2. POST `/bump {"tag":"items"}` on A → relay `publishCount` +1. Poll B ≤ 1 s until `/items/7` has `n` > the old one (fresh). Then wait 500 ms: the relay `publishCount` is still exactly +1 (**L3: B's replay did not publish**). B `l2.received` ≥ 1; A `l2.skipped_own` ≥ 1.
  3. `/plain/1` on A → relay get count unchanged (no L2 for uncached).
  4. `hang-next-get` → B `/items/8` → 200 MISS in < 2 s, `l2.timeouts` 1.
  5. Kill the relay → A `/items/9` → 200 (fail-open); `l2.errors + l2.timeouts` ≥ 1.
- [ ] `bun test --timeout 120000 tests/server/cache-adapter.test.ts` → 5 pass, run twice. Commit.

### Task 11 — Workers e2e under local workerd
- [ ] Fixture `tests/fixtures/cf-l2/` (copy of cf-min's shape; workspace member):
  - `lib/l2.ts` exports `export const L2 = memoryAdapter({ broadcast: 'pull' })`; `cache.ts` default-exports `L2`;
  - `actions.ts`:
    - `POST /bump {tag}` → `cache.invalidate`;
    - `POST /e2e/remote {args}` → `L2.store.invalidate(args)` + `L2.broadcast.publish(args, 'remote')`;
    - `POST /e2e/remote-publish-only {args}` → publish only (simulates KV lag, for the floor);
    - `POST /e2e/hang-next-get`; `GET /e2e/state` → `{ publishCount, gen, seq }`;
  - `brust.toml`: `[cache] adapter = "custom"`, `module = "cache.ts"`, `epoch_interval_ms = 250`; `[cloudflare] stats = true`;
  - `scripts/build-cf.ts` copies cf-min's (honours `BRUST_CF_WASM_READY`).
- [ ] `tests/cf/cache-adapter.test.ts` (`describe.skipIf(process.env.BRUST_CF_E2E !== '1')`; the cf-min spawn/kill pattern). `sleep(300)` is a lower bound only.
  1. `/items/7` MISS → `/__brust_e2e/l1-clear` → `/items/7` `HIT-L2` (same body), `loader_calls` unchanged → `HIT`.
  2. remote `{tags:['items']}` → sleep → `/items/7` MISS; `l2.received` +1; `/e2e/state.publishCount` unchanged by the replay (**L3**).
  3. warm, l1-clear, `remote-publish-only {tags:['items']}` → sleep → `/items/7` is not `HIT-L2` (the floor), `l2.rejected_floor` +1.
  4. `POST /bump` → `publishCount` +1; sleep; `l2.skipped_own` +1; `/items/7` warm → `HIT` survives the own echo.
  5. `hang-next-get` + l1-clear → `/items/8` → 200 within 5 s, `l2.timeouts` +1.
- [ ] `BRUST_CF_E2E=1 bun test --timeout 900000 tests/cf` → all pass; cf-min/pokedex results identical to `$OUT/cf-before.txt`. Commit.

### Task 12 — attribution patch, HIT-path gates
- [ ] Regenerate the patch:
  - `git worktree add $OUT/attr origin/m4cf && cd $OUT/attr && git apply bench/attribution.patch`;
  - then `git -C $OUT/attr stash`; `git -C $OUT/attr checkout --detach lane/cache-adapter-core`; `git -C $OUT/attr stash pop`;
  - resolve any `pipeline.rs` conflict by keeping both sides (attribution timers wrap the same stages; the new L2 block gets no timer);
  - `cargo check -p brust-core` in `$OUT/attr` → 0;
  - `git -C $OUT/attr diff > $W/bench/attribution.patch`; `git worktree remove --force $OUT/attr`.
  - `git apply --check bench/attribution.patch` → exit 0.
- [ ] The gates must print all three:
  - `sed -n '/pub fn get_with/,/^    }$/p' crates/brust-server/src/cache/l1.rs | diff $OUT/getwith.before - && echo GET_WITH-UNCHANGED`;
  - `sed -n '/let hit = s.l1.get_with/,/hit_response(&b, gz));/p' crates/brust-core/src/pipeline.rs | diff $OUT/probe.before - && echo PROBE-UNCHANGED`;
  - `sed -n '/^fn hit_response/,/^}/p' crates/brust-core/src/pipeline.rs | diff $OUT/hitresp.before - && echo HIT_RESPONSE-UNCHANGED`.
- [ ] `git diff origin/m4cf --stat -- crates/brust-server/src/cache/l1.rs crates/brust-server/src/cache/job_cache.rs` → empty. Commit `bench: regenerate attribution.patch over the L2 hooks`.

### Task 13 — spec amendments, CI lines
- [ ] Spec amendments:
  - §3.1: `entryStamp`; the two subpaths (R15).
  - §3.2: L2 wording "write-through on any `Miss{stamp}`; `null` = unguarded"; the `Floor` variant; `clear_all`; `build_id` per R7; `L2Probe`.
  - §3.3: the R2 op set, R3 frames, `CacheCell`.
  - §6: the R4 default, R8 resolution and built-in subpath table.
  - §8: `set_oversize`, R9 counting paths.
  - §10: the boundary as actually used.
  - Header: "lane A landed @<sha>".
- [ ] `ci.yml`: append the five new `packages/brust` test files to the `:166` line, add `bun test --timeout 120000 tests/server/cache-adapter.test.ts` after `:184`, and leave the rest of the file alone. Commit `docs(cache): lane A amendments; ci lines`.

## Acceptance
- **A1:** CLIPPY → 0; `cargo fmt --all -- --check` → 0; `cargo test --workspace --exclude bun_react_compiler` → no FAILED. `cargo test -p brust-server --test l2` → 9 passed; `cargo test -p brust-wasm epoch` → ≥ 17 passed; `cargo test -p brust-server --release --test single_roundtrip` → ok.
- **A2:** `(cd packages/brust && bun run build:debug && bun run build && bun run typecheck && bun test)` → 0 fail. Conformance runs for push and pull are both reported green.
- **A3:** `GET_WITH-UNCHANGED`, `PROBE-UNCHANGED` and `HIT_RESPONSE-UNCHANGED` print; `git apply --check bench/attribution.patch` → 0.
- **A4 (no-adapter identity):**
  - `bun test --timeout 120000 tests/server/pokedex.test.ts` → 0 fail;
  - `bun run battery` and `bun run m2-exit` → report diffs empty;
  - `curl -s <pokedex>/_brust/cache/stats | grep -c '"l2"'` → 0;
  - the D3 entry snapshot test → pass.
- **A5:** `bun test --timeout 120000 tests/server/cache-adapter.test.ts` → 5 pass (twice).
- **A6:** `BRUST_CF_E2E=1 bun test --timeout 900000 tests/cf` → cache-adapter 5 pass, others unchanged.
- **A7:** `rg -n "from ['\"]bun" packages/brust/src/cache-adapter --glob '!conformance.ts'` → empty; `rg -n 'cacheInvalidate\(' packages/brust/src/cache-adapter/runtime.ts` → 0 (the replay path never goes through the publishing wrapper).

## Gates
- `cargo fmt --all -- --check`; CLIPPY; `cargo test --workspace --exclude bun_react_compiler`; `cargo test -p brust-server --release --test single_roundtrip`.
- `cd packages/brust && bun run build:debug && bun run build && bun run typecheck && bun test`.
- `bun test --timeout 120000 tests/server/pokedex.test.ts`; `bun test --timeout 120000 tests/server/hydrate.chromium.test.ts`; `bun run browser-test`; `bun run battery` (+ report diff); `bun run m2-exit` (+ report diff); `bun test scripts/m2-exit`. All of these exercise the changed MISS path with no adapter configured.
- `git apply --check bench/attribution.patch`; `BRUST_CF_E2E=1 bun test --timeout 900000 tests/cf`.
- New: `tests/server/cache-adapter.test.ts`; the three HIT-path gates.
- Not run by this lane: any bench (L4). **After READY, the lead schedules Illenium on the remote host**:
  1. build `lane/cache-adapter-core` and `origin/m4cf` release addons;
  2. `bun bench/run.ts` S/D/I rows, twice each, no `[cache]` in the bench app;
  3. the bar: every row's median RPS ≥ 97 % of base on both runs (rule:bench-hold); else a challenge on this lane.
  runtime-dom gates are unaffected (no file touched).

## Risk ledger
- **Hot path drift.** The no-adapter MISS path gains `if let (Some(l2), …)` and one `Option` at the store. A failing A3 gate or an S/D/I miss in Illenium's run means a regression; the fix is to move the L2 block into a `#[cold]` helper. `CacheOutcome::HitL2` adds one Display arm (logging only).
- **Slot pinning by a hung adapter.** `Detach` holds the claim until JS settles (pool.rs :253-265). `runCache`'s own timers (get = `get_timeout_ms`, set = 5 s) guarantee settlement. Test 4 of Task 10 hangs one get: if a second request then takes > `claim_timeout`, the JS race is broken.
- **Floating promises.** A worker-side unhandled rejection kills the process (run.ts :138-145 via the worker `error` event). Every adapter promise is wrapped with `.catch`, and the runtime test spies on `unhandledRejection`.
- **Cell confusion.** `take/put` now accept two cell types. Task 4 case 6 and the existing `actions.rs` heap tests must both pass. A fetch body offered to a cache call (or the reverse) must be declined, never misread.
- **RefCell across await (Workers).** `maybe_sync` and `l2_get` must drop every `EPOCH`/bridge borrow before awaiting. A JS action calling `cache.invalidate` during a poll otherwise re-borrows → `BorrowMutError` → the e2e shows a 500 + `panicked at`.
- **Seq spaces.** `stamp`, `entryStamp` and event `seq` share one space per adapter. A custom adapter that mixes spaces defeats the guard. The conformance case "`get().stamp` equals the last publish seq" catches it.
- **Native gap blind spot (R10).** A lost final event stays undetected until the next event; the bound is ≤ ttl. Documented in the READY note for lane D.
- **[PD1] coupling.** In the CF bundle `cache` resolves through `cf.ts` → `./cache`. cae0132's `cf-build.test.ts` assertions (`installedRuntime().invalidate(a)`, no `cache.invalidate is server-only`) must stay green after `cache.ts` gains the wrapper.
- **workerd single isolate [I].** The Workers e2e assumes one isolate (as pokedex-d1 Task 8 #8). If replay assertions flake, report it with the observed counts; do not weaken them.
- **Timing.** Only lower-bound sleeps (300 ms > 250 ms interval) and generous upper bounds (≤ 2 s polls) are used. No `timeout` binary (zsh).
- **Shared host.** Kill only spawned PIDs (relay, A, B, wrangler). Never `pkill` by pattern.

## Reporting
`conclave task note 838f12fb-70c1-41b7-acf2-d4065cf6bb64 cache-adapter-core READY @<sha> …` with:
- the commit list; R1-R16 as implemented; the base sha;
- the A1-A7 outputs (counts, the three UNCHANGED lines);
- the wasm size before → after;
- `/_brust/cache/stats` `l2` objects from B (native e2e) and from cf-l2 after case 5;
- the exported API list for lanes B/C: types, `runConformance` caps, the built-in subpath/default-factory contract (R8), the `env:` rule, `entryStamp` semantics, and the Redis Lua guard requirement ("refuse a set whose stamp < last invalidation seq of any of its tags or its method+path");
- every gate with its result;
- the line "no bench run; Illenium S/D/I pending (L4)".

Escalate with `conclave task challenge 838f12fb-70c1-41b7-acf2-d4065cf6bb64 cache-adapter-core "<what, evidence>"` when:
- a HIT-path gate cannot stay unchanged;
- an existing assertion must change other than the `l2: None` literal in `stats_json_shape_is_stable`;
- the D3 snapshot changes;
- `_pipeline_future_is_send` fails;
- a file outside the Boundary is needed;
- local workerd runs more than one isolate.


> **L7 — lead ruling on Mellow's pre-read (native stale re-fill race, 2026-10-12):** (a) `afterInvalidate` sequences `store.invalidate` BEFORE `broadcast.publish` (both still deferred off the request path); unit case: publish starts only after `store.invalidate` settles. (b) `store.invalidate` records the invalidation marker (per tag/path seq) BEFORE deleting, so a concurrent stale `set` from another instance is refused by the write guard even before publish; conformance case: `set(stale)` racing `invalidate(tag)` never lands. (c) Native gets the same `entryStamp` floor as Workers: worker 0 records replayed seqs per tag/path and `l2_get` treats an L2 hit older than that floor as a miss (one map lookup on an L2 hit only; the L1 HIT path is untouched). Task 7 and the test tables are amended accordingly.
