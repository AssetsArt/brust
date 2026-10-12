# m4cf-edge-cache: cross-isolate invalidation epoch on Cloudflare Workers (one `BrustEpoch` Durable Object, exact tag/path/key replay, bounded staleness ≤ `epoch_interval_ms`)
**RULED by lead Detoro 2026-10-12 (before dispatch): R1-R12 ALL ACCEPTED as their defaults — R1 one Rust `#[durable_object] BrustEpoch` singleton (random `gen`, monotonic `seq`, ring of the last 1024 invalidations ≤ 1 MiB; isolates replay missed entries through `Core::invalidate`; behind-the-ring or new `gen` → `clear()` both caches; KV and global-flush rejected on the cited grounds); R2 wasm-only wrapper in `entry.rs` before `core.handle` (no `Host::sync_epoch`, no pipeline.rs change, attribution.patch untouched); R3 awaited poll, one in flight, 500 ms timeout, serve-from-cache on failure + `poll_errors`; R4 outbox drained into one `POST /publish` under `ctx.wait_until` at the end of `fetch`; R5 DO state in memory only (restart = new `gen` = one clear per isolate, never staleness); R6-R8 config `epoch = "durable-object" | "off"`, `epoch_interval_ms` 250-60000 default 1000, optional CONFIG keys under abi 1, the build auto-adds the DO binding on every `env.*` block and declares the class in the user's style (`migrations` or `exports`; Task 2 verifies the pinned wrangler accepts `exports`, else `migrations`); R9 edge cache (Workers Cache + Cache-Tag purge) SPLIT to a follow-up lane 7b — this lane = epoch only — and lane 3's `edgeCache` error text may change "M4-CF-7" → "M4-CF-7b" (pre-approved); R10-R12 ✓ (15 host unit tests; e2e under local workerd with e2e-only test routes proving round trip, remote-only invalidation visible after > 250 ms, exact replay, overflow → clear, gen change → clear, serve-on-DO-failure; optional real-edge Task 11 per bb rule:cloudflare-account, deleted afterwards). Boundary corrected to `cf-wrangler.ts`, `config.ts`, `cf-entry.ts` in packages/brust/src/build (plus `crates/brust-wasm/**`, two additive edits in brust-core: `core.rs` `l1` doc(hidden) pub, `InvalidateArgs` derives, `tests/cf/**`, example wrangler.jsonc, spec §5 amendment). DOCS HANDOFF to lane 8: Free-plan quota note (a busy isolate polling at 1 s ≈ 86% of 100k DO req/day → set `epoch_interval_ms ≥ 5000` or `epoch = "off"`), Paid ≈ $3.74/month per 10 busy isolates at 1 s, DO 1,000 req/s soft limit, location-pinned round trip. Base: m4cf after lane 3 (prefer after 5). Implementer Dew, reviewer Mellow.**
owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · base: m4cf (after lane/m4cf-worker-crate merges; ideally after lane/m4cf-pokedex-d1) · lane: m4cf-edge-cache · tier: complex · review: complex
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

This is lane M4-CF-7 of `docs/design/2026-10-12-m4-cloudflare-workers-design.md`. Read these parts of it first: the header (R5 **AMENDED**: lane 7 is REQUIRED, a cross-isolate epoch, read once per isolate per bounded interval, default 1 s; R6 edge cache off by default), §5 :327-366, §8 :429-444, §9 row M4-CF-7 :458. The contract for `crates/brust-wasm` is lane 3's ruled plan `docs/plans/2026-10-12-m4cf-worker-crate.md`, **including the two amendments**: `invalidate` reaches wasm only through `install({ invalidate })` (ruling 19753649), and `edgeCache != "off"` is a boot error naming M4-CF-7 (its R2d).

Grounding: m4cf @**9ab4c34** (lanes 1, 2, 4 merged). Lane 3 is NOT merged: its files are cited from the ruled plan plus its WIP branch `lane/m4cf-worker-crate` @7000d17 (`[L3]`). Re-anchor every `[L3]` reference on the quoted text after lane 3 merges. **[C]** = Cloudflare doc, fetched 2026-10-12. **[I]** = inference that a task verifies.

## Facts the plan rests on
- **Invalidation clock** (`crates/brust-core/src/cache/stamp.rs:15-29`): `InvalClock(AtomicU64)`, `stamp() -> ReadStamp`, `next()` takes the next seq. `INVAL_SLOTS = 256` (:33). One clock per `Core`, shared by L1 and the job cache (`core.rs:106-107,128-130`).
- **Local caches** (`cache/local.rs`): `LocalL1<T: Clock>` (:262) and `LocalJobs<T: Clock>` (:445) publish `inval.next()` into hashed slots on every `invalidate_tags` (:399-406, :569-575), `invalidate_path` (:408-428) and `invalidate_user_key` (:577-582). An insert whose `ReadStamp` predates a covering slot does not land (:315-322, :501-507). **`clear()` is an inherent method on both** (:331-339 returns the live count; :515-518), not part of `PageCache`/`JobStore` (`host.rs:148-186`). It sets `cleared_at = inval.next()`, so in-flight inserts stamped earlier are refused.
- **Core** (`crates/brust-core/src/core.rs`): `pub(crate) l1: H::L1` (:50), `#[doc(hidden)] pub jobs: H::Jobs` (:51-52). `Core::invalidate(InvalidateArgs) -> InvalidateResult` (:151-165): `key` → jobs by user key; `tags` → both caches; `path` (+`method`, default `GET`) → L1. No `clear` on `Core`.
- **Args** (`config.rs:160-171`): `#[derive(Debug, Default, Deserialize)] pub struct InvalidateArgs { key: Option<String>, tags: Vec<String>, path: Option<String>, method: Option<String> }`. There is **no `Serialize`/`Clone`**. The `Stats` JSON shape is pinned by `stats_json_shape_is_stable` (:294), so epoch counters cannot go into `/_brust/cache/stats`.
- **Pipeline** (`pipeline.rs:64-148`): the HIT probe is in `page()` at :204-216, and the stamp is `s.clock.stamp()` at :220. `bench/attribution.patch` has hunks in `pipeline.rs` (:97, :121, :139, :179 …). **This lane does not edit `pipeline.rs`.**
- **Wasm entry [L3]** (`crates/brust-wasm/src/entry.rs`):
  - `#[event(fetch)] async fn fetch(req: Request, _env: Env, _ctx: Context)` (:67-68);
  - the stats gate (:86-87) and the e2e panic route under `option_env!("BRUST_WASM_E2E")` (:83-85) run before `AssertUnwindSafe(core.handle(rq, req)).catch_unwind()` (:95);
  - `CORE: OnceCell<&'static Core<WasmHost>>` (:16-17).
- **Wasm bridge [L3]** (`bridge.rs:63-90`): `install(core)` hands JS `{ invalidate }`. The closure runs `core.invalidate(args)` synchronously and returns `{l1Removed, jobRemoved}`. **The app calls it from inside an action**, i.e. inside the `core.handle` of the request that runs that action.
- **Wasm config [L3]** (`config.rs`): `CfConfig` is `#[serde(rename_all = "camelCase", deny_unknown_fields)]` (:10). It requires `abi == 1`; `edgeCache != "off"` → `CONFIG: edgeCache … (the edge cache is M4-CF-7)` (:67-70).
- **Build side** (m4cf, lane 4):
  - `packages/brust/src/build/config.ts:26` `CF_KEYS`; `:70-73` rejects `edge_cache = "workers-cache"` with "lands with M4-CF-7"; `CloudflareBuildConfig` :30-39.
  - `cf-entry.ts:3-12` `CfConfigJson`.
  - `cloudflare.ts:187-197` builds `CONFIG`; `:163` the smoke check requires `CONFIG.abi === 1`.
  - `cf-wrangler.ts:78-113` `mergeWrangler`: `OWNED` keys :25; the user's other keys are copied; `env.*` blocks are cleaned :94-104.
- **cf-min [L3]:** `tests/fixtures/cf-min/scripts/build-cf.ts` runs the REAL `brust build --target cloudflare` (lane 4) against `npm/core-cf`. Its `brust.toml` has `[cloudflare] name = "brust-cf-min"`, `stats = true`. The e2e runs as `BRUST_CF_E2E=1 bun test --timeout 900000 tests/cf` under pinned `bunx wrangler` (`tests/cf/tools.ts`).
- **worker-build 0.8.7 exports every wasm-bindgen class** (`worker-build-0.8.7/src/main.rs:231-272` `add_export_wrappers`: each `export class X` in `index.js` becomes `export const X = new Proxy(…)` in the shim). Plain functions are not exported (L3 spike: `index.js` exports `{ContainerStartupOptions, MinifyConfig, R2Range, default}`). So a `#[durable_object] pub struct BrustEpoch` is exported as class `BrustEpoch` [I: Task 2 proves it under wrangler].
- **workers-rs 0.8.7 API** (local registry source):
  - `trait DurableObject { fn new(state: State, env: Env) -> Self; async fn fetch(&self, req: Request) -> Result<Response>; … }` (`durable.rs:986-1006`);
  - `Env::durable_object(&self, binding) -> Result<ObjectNamespace>` (`env.rs:82`); `ObjectNamespace::get_by_name(&self, name) -> Result<Stub>` (`durable.rs:159`); `Stub::fetch_with_str(&self, url) -> Result<Response>` (:59), `fetch_with_request` (:52);
  - `Context::wait_until<F: Future<Output = ()> + 'static>(&self, f)`; `worker::Delay: From<Duration>` (`delay.rs:26,70`); `Env: Clone` (`env.rs:22`).
- **Cloudflare facts [C]:**
  - DO pricing <https://developers.cloudflare.com/durable-objects/platform/pricing/>: Free 100,000 requests/day + 13,000 GB-s/day, and "further operations … will fail with an error" past them. Free plan is SQLite-backed only. Paid: 1 M requests/month, then $0.15/M; 400,000 GB-s/month, then $12.50/M GB-s. Duration is wall-clock while active, at 128 MB.
  - DO limits <https://developers.cloudflare.com/durable-objects/platform/limits/>: "soft limit of 1,000 requests per second" per object, overloaded error beyond; single-threaded.
  - DO location <https://developers.cloudflare.com/durable-objects/reference/data-location/>: created "close to where the initial `get()` request is made"; "do not currently change locations".
  - KV <https://developers.cloudflare.com/kv/concepts/how-kv-works/>: "Changes may take up to 60 seconds or more to be visible in other global network locations". KV limits: 1 write/s per key, minimum `cacheTtl` 30 s.
  - Wrangler config <https://developers.cloudflare.com/workers/wrangler/configuration/>: `durable_objects` is **non-inheritable** (each `env.*` repeats it); `migrations` is inheritable, "Legacy imperative configuration"; "`migrations` and Durable Object entries in `exports` are mutually exclusive". The `exports` shape is `{"Cls": {"type": "durable-object", "storage": "sqlite"}}`.
  - Purge <https://developers.cloudflare.com/cache/how-to/purge-cache/>: purge by tag is available on **all plans** (Free/Pro/Business/Enterprise), i.e. NOT Enterprise-only any more. Free tag/prefix/host rate: 5/minute, bucket 25.
  - Workers Cache <https://developers.cloudflare.com/workers/cache/>, `/purge/`: `[cache] enabled = true`; a HIT skips the Worker; `ctx.cache.purge({tags | pathPrefixes | purgeEverything})` propagates "with the same guarantees as zone-level purges", but "**Workers Cache always uses the Free tier limits**" (5 purges/minute). Enabling it bills every request, static assets included.
  - Cache API <https://developers.cloudflare.com/workers/runtime-apis/cache/>: per data center; `cache.delete` purges only the local colo; `cache.put` is not tiered.

## Goal
- A `cache.invalidate({tags|path|key})` that runs in one isolate reaches **every** isolate of the Worker within `epoch_interval_ms` (default 1000) + one poll round trip (≤ 500 ms timeout), instead of up to the route `ttl`. Unrelated entries survive: the replay is exact (the same `Core::invalidate` arguments), not a flush.
- One Durable Object class `BrustEpoch`, written in Rust in `crates/brust-wasm` (no hand-written JS, H3). It holds a random `gen`, a monotonic `seq` and a ring of the last 1024 invalidations. Isolates `GET /since` at most once per interval. An isolate further behind than the ring, or one that sees a new `gen`, `clear()`s both caches.
- `brust.toml [cloudflare] epoch = "durable-object" | "off"` (default `"durable-object"`) and `epoch_interval_ms` (250..=60000, default 1000). `brust build --target cloudflare` adds the `BRUST_EPOCH` binding and the class declaration to `dist/cf/wrangler.jsonc` automatically (R8).
- Native is unchanged: `pipeline.rs` is untouched; core gains only a `#[doc(hidden)]` visibility change and two derives. `git apply --check bench/attribution.patch` passes.
- `GET /_brust/cache/epoch` (only when `[cloudflare] stats = true`) reports `{mode, gen, seq, polls, replayed, resets, poll_errors, published, publish_errors}`. The e2e under local workerd proves the DO round trip, a remote-only invalidation becoming visible after the interval, overflow → clear, gen change → clear, and fail-open on a DO error.
- Spec §5/§8/§9 and the R5 header are amended with the semantics table below. `edge_cache = "workers-cache"` stays rejected and moves to follow-up lane 7b (R9).

### Semantics table (goes into spec §5 and later `docs/cloudflare.md`)
| | native `brust start` | Workers, `epoch = "durable-object"` (default) | Workers, `epoch = "off"` | edge cache (lane 7b, opt-in) |
|---|---|---|---|---|
| isolate/process that ran the action | immediate | immediate (local `Core::invalidate`) | immediate | — |
| every other isolate | n/a (one process) | ≤ `epoch_interval_ms` + poll RTT after the DO holds the entry; the entry leaves via `ctx.waitUntil` right after the action's response (R4) | ≤ route `ttl` | Workers Cache tag purge, global, but ≤ 5 purges/min (Free-tier limits always) |
| isolate idle longer than the interval | n/a | its first request awaits the poll (≤ 500 ms) before the L1 probe | ≤ `ttl` | — |
| DO unreachable / quota exhausted | n/a | fail-open: serves its cache, `poll_errors`++, so staleness falls back to ≤ `ttl` | — | — |
| unrelated tags/paths | kept | kept (exact replay) | kept | kept |
| ring overflow / DO restarted (`gen` changed) | n/a | `clear()` of L1 + jobs in that isolate | — | — |

## Rulings requested
**R1 — Epoch source.** *Default (a):* one DO class `BrustEpoch`, a singleton reached by `get_by_name("brust-epoch")`. It keeps `gen` (random u64, hex string on the wire), `seq: u64`, and a ring `VecDeque<(seq, InvalidateArgs)>` capped at 1024 entries **and** 1 MiB of serialized args (oldest dropped first). `GET /since?gen=G&seq=S` returns one of: the entries with seq > S; `{reset:true}` when G ≠ gen or S < oldest−1; up to date. `POST /publish {entries:[args…]}` appends and returns `{gen, seq}`. Each isolate replays missed entries through `Core::invalidate`. *Rejected:* (b) KV key `brust:epoch`: "up to 60 seconds or more" to propagate, 30 s minimum `cacheTtl`, 1 write/s per key [C]. That alone breaks the 1 s bound and throttles bursts of mutations. (c) Global flush on any epoch change: a single integer, simple, but every mutation empties every isolate's L1 and job cache, so the hit rate collapses under write load (the pokedex `/team` action would flush `/dex` too).

**R2 — Hook placement.** *Default:* a **wasm-only wrapper** in `entry.rs` `fetch`, before `core.handle`, inside the same `catch_unwind` future: `epoch::maybe_sync(core, &env).await` for GET/HEAD requests outside the stats/epoch/e2e gates. After `handle`: `epoch::drain()` → `ctx.wait_until(publish)`. It needs no `Host` change, no `pipeline.rs` hunk and no native no-op. It sits before the L1 probe because `handle` → `page()` → probe (:204). *Alternative:* a new `Host::sync_epoch()` async hook with a default no-op, called from `pipeline::page` before :204. Rejected because the host cannot reach `Core`'s caches (it would need a callback or a `&Core` parameter), and it adds an attribution.patch hunk.

**R3 — Poll mode.** *Default:* **awaited, single-flight, 500 ms timeout, fail-open.**
- The request that finds `now − last_poll ≥ interval` sets `in_flight` and awaits `select(stub.fetch, Delay(500 ms))`.
- Concurrent requests during the poll do not wait.
- On timeout or error: keep the caches, `poll_errors`++, `last_poll = now` (retry next interval), and `console.warn` once per 60 s.

Awaiting matters because an isolate that idled for minutes must not serve a stale HIT on its first request. A detached poll would bound staleness only by "time since the last poll", which is unbounded for idle isolates. *Alternatives:* detached (`waitUntil`) poll (no request ever waits, but no bound after idle); fail-closed (bypass L1/jobs while the epoch is unknown: correct under a DO outage, but a DO outage then becomes a full-render storm).

**R4 — Publishing a local invalidation.** *Default:* `bridge::invalidate` (L3) runs the local `core.invalidate`, then pushes the args to an isolate outbox (`RefCell<Vec<InvalidateArgs>>`). At the end of every `fetch`, a non-empty outbox is drained into ONE `POST /publish` under `ctx.wait_until`, with one retry; a failure means `publish_errors`++ and `console.error`. The action's response is not delayed. *Alternative:* await the POST before answering the action. This gives "visible everywhere within the interval of the response", at +1 DO round trip on every mutating action (up to ~hundreds of ms when the DO is on another continent [I]).

**R5 — DO state.** *Default:* in-memory only (`RefCell<Ring>`). `gen` is drawn at construction (`js_sys::Math::random` ×2 → u64 hex). There are no storage writes. A DO eviction or restart (idle, deploy) yields a new `gen`, and every isolate `clear()`s once: loss always degrades to a clear, never to staleness. The class is SQLite-declared only because Free plans have no KV-backed DOs [C]. *Alternative:* persist `seq` + ring in DO SQLite storage (`state.storage().sql()`): restarts keep the ring, so no clear on deploy, at the cost of a storage write per publish.

**R6 — Defaults.**
- *Default:* `epoch_interval_ms = 1000`, accepted range 250..=60000 (build error outside it);
- ring 1024 entries / 1 MiB, **constants** in `epoch/ring.rs` (not configurable);
- a single entry over 64 KiB serialized is stored as a reset marker (`{"clear":true}` → isolates `clear()`);
- poll timeout 500 ms (constant).

*Alternatives:* `epoch_ring` as a config key; interval minimum 100 ms.

**R7 — CONFIG contract.** *Default:* keep `abi: 1` (nothing is published yet; brust and `@brust/core-cf` land together on m4cf). Add two **optional** keys to `CfConfigJson`/`CfConfig`: `epoch: "durable-object" | "off"` (serde default `"off"`, so an old CONFIG keeps the preview semantics) and `epochIntervalMs` (default 1000). The build always writes both. *Alternative:* bump `abi` to 2 (brust then refuses an older core-cf at build time via `cf-core.ts:49`, instead of failing at wrangler deploy with "class BrustEpoch not exported").

**R8 — Wrangler binding: auto-add.** *Default:* `mergeWrangler` adds the binding itself, because `durable_objects` is non-inheritable [C].
- When `epoch != "off"`, it adds `{"name":"BRUST_EPOCH","class_name":"BrustEpoch"}` to the top-level `durable_objects.bindings` and to every `env.<name>` block.
- It **always** declares the class, whatever the mode. Toggling `epoch` off after a deploy must not drop a deployed class.
  - If the user's config has `migrations`, it appends `{"tag":"brust-epoch-v1","new_sqlite_classes":["BrustEpoch"]}` unless a migration already names `BrustEpoch`.
  - Else, if the user's `exports` has any entry, it adds `exports.BrustEpoch = {"type":"durable-object","storage":"sqlite"}`.
  - Else it appends to a new `migrations` (the widest wrangler support; the pinned wrangler is proven in Task 2).
- `BuildError('cf-config', …)` when:
  - a user binding `BRUST_EPOCH` names another class;
  - a user binding or class uses the name `BrustEpoch` for their own DO;
  - the user config uses `exports` DO entries AND `migrations` (wrangler forbids it anyway).

*Alternative:* require the user to declare the binding and migration (`epoch` then defaults to `"off"` when no `BRUST_EPOCH` binding is found). This touches `examples/pokedex/wrangler.jsonc` and the create-app templates.

**R9 — Edge cache split.** *Default:* **this lane = the epoch only.** `edge_cache = "workers-cache"` stays rejected (message → "lands with M4-CF-7b"). A follow-up lane `m4cf-edge-cache-b` delivers `[cache] enabled = true` + `Cache-Tag` + `ctx.cache.purge({tags})`, eligible routes only. Facts recorded for 7b:
- tag purge is on all plans (not Enterprise-only) [C];
- Workers Cache purges always use Free-tier limits, 5/min with a burst of 25 [C], so 7b must coalesce purges and fall back to `pathPrefixes`/`purgeEverything` beyond the bucket;
- enabling Workers Cache bills static-asset requests [C];
- `caches.default` + `cache.delete` is colo-local [C], so it is not a coherent option.

*Alternative:* ship 7b in this lane (doubles the scope; needs a real-edge test because local workerd has no Workers Cache [I]).

**R10 — Test hooks.** *Default:* reuse lane 3's compile-time gate `option_env!("BRUST_WASM_E2E")` (the e2e wasm only; release wasm never contains these). Isolate routes, all in `entry.rs` before the sync hook:
- `POST /__brust_e2e/epoch/publish` body `{entries:[…]}` → forwarded to the DO **without** a local invalidate (simulates another isolate);
- `POST /__brust_e2e/epoch/regen` → DO draws a new `gen`;
- `POST /__brust_e2e/epoch/fail-next` → the DO answers its next `/since` with 503.

The DO-side `/e2e/*` paths are compiled under the same gate. *Alternative:* a runtime header (`x-brust-e2e`) gated by `stats = true`: one wasm, but a hook in production code paths.

**R11 — Observability.** *Default:* a separate JSON endpoint `GET /_brust/cache/epoch`, served by the wasm adapter only when `CONFIG.stats` (same gate as L3 R11, else the `error_404` bytes). It never triggers a poll. The native `/_brust/cache/epoch` stays a 404 (static root `/_brust/` → `safe_rel` refuses). *Alternative:* add `epoch` to `Stats`: this changes the pinned shape (`config.rs:294`) and the native JSON.

**R12 — Real-edge proof.** *Default:* an optional Task 12 under bb rule:cloudflare-account: deploy `brust-test-m4cf-edge-cache-<sha>` with the DO, mutate, and sample fresh-vs-stale across ≥ 50 fresh connections for 3 s. Report the max observed staleness, then delete in `finally`. *Alternative:* skip it (local workerd runs one isolate, so true cross-isolate behaviour is only inferred).

## Boundary
- `crates/brust-wasm/src/{entry.rs,bridge.rs,config.rs,lib.rs}` (hooks, outbox push, CONFIG keys), new `crates/brust-wasm/src/epoch/{mod.rs,ring.rs,cursor.rs,wire.rs,sync.rs,object.rs}`, `crates/brust-wasm/scripts/build.ts` (class-export assertion only), `crates/brust-wasm/Cargo.toml` only if a feature is needed.
- `crates/brust-core/src/core.rs` (:50 `l1` → `#[doc(hidden)] pub`, nothing else); `crates/brust-core/src/config.rs` (:161 derive `Serialize, Clone, PartialEq` on `InvalidateArgs`; `skip_serializing_if` on the options). Additive only. **Not** `host.rs`, `cache/local.rs` or `cache/stamp.rs`: the design needs nothing there (R2), contrary to the brief's guess.
- `packages/brust/src/build/{config.ts,cf-entry.ts,cf-wrangler.ts,cloudflare.ts}` + `packages/brust/test/cf-{config,entry,wrangler,build}.test.ts`.
- `tests/fixtures/cf-min/brust.toml` (+`epoch_interval_ms = 250`), `tests/cf/**` (new `cf-epoch.test.ts`, `edge-proof-epoch.ts`).
- Docs: `docs/design/2026-10-12-m4-cloudflare-workers-design.md` (header R5 line, §5 rows :332/:336 + the table, §8 row, §9 row :458), and `docs/cloudflare.md` only if lane 8 already created it. Also `examples/pokedex/README.md` and the template README staleness sentence lane 5 (R8) wrote: one sentence each.
- NOT: `pipeline.rs`, `crates/brust-server/**`, `crates/brust-napi/**`, `packages/brust/src/{worker,handlers,actions-bridge}.ts`, `examples/pokedex/wrangler.jsonc` (unless R8's alternative is ruled), `.github/workflows/*` (the `cf` job already runs `tests/cf`). Anything else → `conclave task challenge`.

## Tasks
Every Rust task ends green on: `cargo fmt --all -- --check`; `cargo clippy -p brust-core -p brust-compiler -p brust-compiler-cli -p brust-jinja -p brust-server -p brust-napi -p brust-wasm --no-deps -- -D warnings`; `cargo clippy -p brust-wasm --target wasm32-unknown-unknown --no-deps -- -D warnings`; `cargo test -p brust-core -p brust-wasm`. `OUT=/tmp/m4cf-edge-cache` (never committed). Commit per task.

### Task 1 — worktree, base, baseline
- [ ] `git -C /Users/detoro/code/brust fetch origin m4cf && git -C /Users/detoro/code/brust worktree add /Users/detoro/code/brust-lane-m4cf-edge-cache -b lane/m4cf-edge-cache origin/m4cf && cd /Users/detoro/code/brust-lane-m4cf-edge-cache && grep -q 'pub fn install' crates/brust-wasm/src/bridge.rs && grep -q 'M4-CF-7' crates/brust-wasm/src/config.rs && echo base-ok` → `base-ok`. Otherwise lane 3 is not merged: challenge and stop.
- [ ] `bun install --frozen-lockfile && (cd packages/brust && bun run build:debug)` → exit 0. `worker-build --version` → `0.8.7`. `grep WRANGLER tests/cf/tools.ts` → record the pin.
- [ ] `mkdir -p $OUT && cargo test -p brust-core -p brust-server -p brust-wasm 2>&1 | tee $OUT/t1.txt | grep -c '^test result: ok'`; `grep FAILED $OUT/t1.txt` → empty. Names: `cargo test -p brust-core -p brust-wasm -- --list 2>/dev/null | grep ': test$' | sort > $OUT/names-before.txt`.
- [ ] `(cd packages/brust && bun test test/cf-config.test.ts test/cf-wrangler.test.ts test/cf-entry.test.ts test/cf-build.test.ts)` → 0 fail. `BRUST_CF_E2E=1 bun test --timeout 900000 tests/cf 2>&1 | tail -3` → 0 fail (the lane-3/5 baseline). `git apply --check bench/attribution.patch` → 0.

### Task 2 — spike: the DO class under worker-build + the pinned wrangler (R5, R8 facts)
- [ ] In `crates/brust-wasm/src/epoch/object.rs` (cfg wasm32), a minimal `#[durable_object] pub struct BrustEpoch { n: Cell<u64> }` with `fetch` answering `n++`. `bun crates/brust-wasm/scripts/build.ts --e2e --out $OUT/w` → exit 0. `grep -c 'export const BrustEpoch' $OUT/w/index.js` (or the bundled shim) → ≥ 1; record where.
- [ ] Spike entry route `GET /__brust_e2e/epoch/ping` (E2E gate): `env.durable_object("BRUST_EPOCH")?.get_by_name("brust-epoch")?.fetch_with_str("https://brust-epoch/ping")` → body. Build cf-min with a hand-edited `dist/cf/wrangler.jsonc` adding the binding and **(a)** `migrations` `new_sqlite_classes`, then **(b)** `exports {type,storage:"sqlite"}`. For each: `wrangler dev` (lane-3 flags) + `curl` twice → `1` then `2`; `wrangler deploy --dry-run` → exit 0. Write `$OUT/spike.md`: (a) ok?, (b) ok?, the export line, and `typeof` checks.
- [ ] If (a) fails → challenge (the class is not reachable; the R1 design stops). If only (b) fails → R8's "neither" branch stays `migrations`, and `exports` support is dropped with a note. Commit `test(wasm): BrustEpoch DO spike (M4-CF-7)`.

### Task 3 — core: additive seams
- [ ] **Tests first** (`config.rs` tests): `invalidate_args_round_trip` — `serde_json::to_string(&InvalidateArgs { key: None, tags: vec!["a".into()], path: Some("/x".into()), method: None })` == `{"tags":["a"],"path":"/x"}`, and deserializing it back is `==` the original. Red: no `Serialize`.
- [ ] `config.rs:161`: `#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]` + `#[serde(skip_serializing_if = "Option::is_none")]` on `key`/`path`/`method`, `#[serde(skip_serializing_if = "Vec::is_empty")]` on `tags`.
- [ ] `core.rs:50`: `#[doc(hidden)] pub l1: H::L1,` with the comment "native-host seam: the Workers host clears it on an epoch reset (M4-CF-7)". No other line changes.
- [ ] `cargo test -p brust-core` → +1 pass; `cargo test -p brust-server` → the t1 count; `git apply --check bench/attribution.patch` → 0. Commit `feat(core): InvalidateArgs serializes; l1 is a host seam (M4-CF-7)`.

### Task 4 — `epoch/ring.rs`, `cursor.rs`, `wire.rs` (pure, host-tested)
- [ ] `wire.rs`: `PublishReq { entries: Vec<Entry> }`; `enum Entry { Args(InvalidateArgs), Clear }`, serialized as the args object or `{"clear":true}`; `PublishResp { gen: String, seq: u64 }`; `SinceResp { gen: String, seq: u64, reset: bool, entries: Vec<(u64, Entry)> }`; `fn since_url(gen: Option<&str>, seq: u64) -> String` = `https://brust-epoch/since?seq=<n>[&gen=<g>]`.
- [ ] **Tests first** `ring.rs` (`Ring::new(gen, cap_entries, cap_bytes)`):
  - `publish_assigns_consecutive_seqs` (3 entries → seq 1..=3; returns 3);
  - `since_returns_only_newer` (since 1 → seqs 2, 3);
  - `since_up_to_date_is_empty_not_reset`;
  - `wrong_gen_is_reset`;
  - `behind_the_ring_is_reset` (cap 4, publish 6, since 1 → reset; since 2 → seqs 3..=6);
  - `byte_cap_drops_oldest`;
  - `oversize_entry_becomes_clear` (> 64 KiB → `Entry::Clear`);
  - `since_ahead_of_seq_is_reset` (an isolate claims seq 9 of a gen at 3: impossible unless a bug → reset);
  - `missing_gen_adopts` (first contact: `gen = None` → `reset: false`, entries empty, current seq: the isolate adopts).
- [ ] **Tests first** `cursor.rs` (`Cursor { gen: Option<String>, seq: u64, last_poll_ns: u64, in_flight: bool }`):
  - `due_after_interval_only` (`due(now, interval)`; never while `in_flight`);
  - `first_contact_adopts_without_replay`;
  - `apply_replays_in_seq_order` → `Plan::Replay(vec![…])`, cursor seq = resp.seq;
  - `apply_reset_plans_clear`;
  - `clear_entry_inside_a_replay_plans_clear` (once, the rest skipped);
  - `failure_keeps_seq_and_moves_last_poll`.
- [ ] Implement; ring/cursor constants `RING_ENTRIES = 1024`, `RING_BYTES = 1 << 20`, `ENTRY_BYTES = 64 << 10`, `POLL_TIMEOUT_MS = 500` (R6). `cargo test -p brust-wasm epoch` → 15 passed. Commit.

### Task 5 — CONFIG keys (Rust + build), R6/R7
- [ ] **Tests first** `crates/brust-wasm/src/config.rs`:
  - CONFIG without `epoch` → `EpochCfg { on: false, interval_ms: 1000 }`;
  - `"epoch":"durable-object","epochIntervalMs":250` → on, 250;
  - `"epoch":"kv"` → Err naming `epoch`; `epochIntervalMs: 249` and `60001` → Err naming `epochIntervalMs`;
  - `edgeCache: "workers-cache"` → Err whose text contains `M4-CF-7b`.
  - `parse` returns `(CoreConfig, stats, EpochCfg)`.
- [ ] **Tests first** `packages/brust/test/cf-config.test.ts`:
  - `[cloudflare]` without keys → `epoch: 'durable-object', epochIntervalMs: 1000`;
  - `epoch = "off"` ok; `epoch = "kv"` → BuildError `cloudflare.epoch must be "durable-object" or "off"`;
  - `epoch_interval_ms = 100` → `must be an integer in 250..60000`;
  - `edge_cache = "workers-cache"` → `lands with M4-CF-7b`.
  - `cf-entry.test.ts`: the CONFIG literal contains `"epoch":"durable-object","epochIntervalMs":1000`.
- [ ] `config.ts`: `CF_KEYS` += `epoch`, `epoch_interval_ms`; `CloudflareBuildConfig` += `epoch: 'durable-object' | 'off'`, `epochIntervalMs: number`; the parse + the 7b message. `cf-entry.ts` `CfConfigJson` += both. `cloudflare.ts:35` `DEFAULT_CFG` and :187-197 write both.
- [ ] `cargo test -p brust-wasm config` and `(cd packages/brust && bun test test/cf-config.test.ts test/cf-entry.test.ts)` → green. Commit.

### Task 6 — wrangler merge (R8)
- [ ] **Tests first** `packages/brust/test/cf-wrangler.test.ts` (a `mergeWrangler` option `epoch: boolean`):
  1. empty user config, epoch on → `durable_objects.bindings == [{name:"BRUST_EPOCH",class_name:"BrustEpoch"}]`, `migrations == [{tag:"brust-epoch-v1",new_sqlite_classes:["BrustEpoch"]}]`;
  2. epoch off → no `durable_objects`, the migration is still present;
  3. the user has `migrations:[{tag:"v1",new_sqlite_classes:["Room"]}]` + a `ROOM` binding → both kept, brust's appended after them;
  4. the user has `exports:{Room:{type:"durable-object",storage:"sqlite"}}` → `exports.BrustEpoch` added, no `migrations` key;
  5. `env.staging` without DOs → gains the binding; `env.prod` with its own DO bindings → the binding is appended;
  6. a user binding `BRUST_EPOCH` → class `Other` → BuildError `cf-config`;
  7. a user class `BrustEpoch` → BuildError;
  8. the user already has migration `brust-epoch-v1` → not duplicated (idempotent re-build).
- [ ] Implement in `cf-wrangler.ts` after the `env` loop (:94-104); `cloudflare.ts:240` passes `epoch: p.cfg.epoch !== 'off'`. If Task 2 (b) failed, case 4 asserts a BuildError ("exports-style DO config needs wrangler ≥ X"), with the version from the spike.
- [ ] `(cd packages/brust && bun test test/cf-wrangler.test.ts test/cf-build.test.ts && bun run typecheck)` → green. Commit.

### Task 7 — the DO (`epoch/object.rs`, wasm32) + `scripts/build.ts` assertion
- [ ] `BrustEpoch { ring: RefCell<Ring>, fail_next: Cell<bool> }`. `new` draws `gen` (R5).
  - `fetch`:
    - `GET /since` → `SinceResp` JSON (503 once if `fail_next`);
    - `POST /publish` → parse `PublishReq` (bad JSON → 400), `ring.publish` → `PublishResp`;
    - under the E2E gate also `POST /e2e/regen` (new gen, empty ring, seq 0) and `POST /e2e/fail-next`;
    - anything else → 404.
  - No storage calls, no `await` while a `RefCell` borrow is held.
- [ ] `scripts/build.ts`: after the R1 rewrite, assert the shim/bundle exports `BrustEpoch` (the exact grep proven in Task 2), else exit 1 with `BrustEpoch DO class not exported`.
- [ ] wasm clippy → 0; `bun crates/brust-wasm/scripts/build.ts --e2e --out $OUT/w` → exit 0, the size line printed (lane 3's < 4 MiB bar still holds). Commit.

### Task 8 — isolate sync, outbox, endpoints (`epoch/sync.rs`, `epoch/mod.rs`, `entry.rs`, `bridge.rs`)
- [ ] `epoch/mod.rs` (thread_local `EPOCH: RefCell<State>`): `State { cfg: EpochCfg, cursor: Cursor, outbox: Vec<InvalidateArgs>, counters }`; `fn queue(args)`, `fn drain() -> Option<PublishReq>`, `fn snapshot_json() -> Vec<u8>`.
- [ ] `sync.rs`:
  - `async fn maybe_sync(core: &Core<WasmHost>, env: &Env)`: if off or not `due` → return; else set `in_flight`. Get the stub. A missing binding → `mode = "missing-binding"` + one `console.error`, then return with polls disabled.
  - `select(stub.fetch_with_str(&since_url(..)), Delay::from(500 ms))`, then parse `SinceResp` → `cursor.apply` → execute the plan:
    - `Replay(v)` → `core.invalidate(args.clone())` for each, `replayed += n`;
    - `Clear` → `core.l1.clear(); core.jobs.clear();`, `resets += 1`;
    - a failure → `poll_errors += 1`.
  - Release no borrow across an `.await`: take the cursor fields out, await, then re-borrow.
  - `async fn publish(env: Env, req: PublishReq)`: up to 2 attempts; on success record `published += n`, else `publish_errors += 1` + `console.error`.
- [ ] `bridge.rs` `invalidate` [L3 :79-90]: after `core.invalidate(args)`, `epoch::queue(args)` when on (clone before the move).
- [ ] `entry.rs` `fetch`:
  - rename `_env, _ctx` → `env, ctx`;
  - before the stats gate: `if STATS && method == GET && full == "/_brust/cache/epoch"` → `body::resp(200, "application/json", &[], epoch::snapshot_json())`; without STATS → the existing 404 bytes;
  - the E2E routes (R10);
  - wrap `async { if GET|HEAD { epoch::maybe_sync(core, &env).await }; core.handle(rq, req).await }` in the existing `AssertUnwindSafe(..).catch_unwind()`;
  - after `finish`: `if let Some(p) = epoch::drain() { ctx.wait_until(epoch::sync::publish(env.clone(), p)) }`.
- [ ] Snapshot JSON shape (pinned by a host test in `epoch/mod.rs`): `{"mode":"durable-object","gen":null,"seq":0,"polls":0,"replayed":0,"resets":0,"poll_errors":0,"published":0,"publish_errors":0}`.
- [ ] wasm clippy → 0; `cargo test -p brust-wasm` → green. Commit.

### Task 9 — e2e `tests/cf/cf-epoch.test.ts` (local workerd, one isolate)
- [ ] `tests/fixtures/cf-min/brust.toml` `[cloudflare]` += `epoch_interval_ms = 250`. Reuse lane 3's harness (spawn, readiness, kill only our PID) from `tests/cf/`. `describe.skipIf(process.env.BRUST_CF_E2E !== '1')`. `E()` = GET `/_brust/cache/epoch` JSON; `sleep(300)` > interval (a lower bound only, no upper-bound timing).
- [ ] Assertions, in order:
  1. `dist/cf/wrangler.jsonc` has the `BRUST_EPOCH` binding + the `brust-epoch-v1` migration; `E().mode == "durable-object"`, `polls == 0`.
  2. `GET /items/7` → MISS, then `GET` → HIT; `E().polls ≥ 1`, `E().gen` is a non-empty string.
  3. **Remote-only invalidation:** `POST /__brust_e2e/epoch/publish {"entries":[{"tags":["items"]}]}` → 200 `{gen, seq}`; `E().replayed` unchanged (local invalidate skipped); `sleep(300)`; `GET /items/7` → **MISS**; `E().replayed` +1.
  4. **Exactness:** warm `/items/7` and `/items/8` (HIT both); publish `{"path":"/items/8"}`; `sleep(300)`; `/items/7` → HIT, `/items/8` → MISS.
  5. **Own publish:** `POST /_brust/action/bump {"tag":"items"}` → 200; poll `E().published ≥ 1` for ≤ 5 s (it waits on `waitUntil`, so the loop is deterministic).
  6. **Overflow:** publish 1025 entries `{"tags":["noise-<i>"]}` in one POST; `sleep(300)`; `GET /items/7` → MISS; `E().resets` +1.
  7. **gen change:** warm `/items/7` → HIT; `POST /__brust_e2e/epoch/regen`; `sleep(300)`; `GET /items/7` → MISS; `resets` +1.
  8. **Fail-open:** warm → HIT; `POST /__brust_e2e/epoch/fail-next`; `sleep(300)`; `GET /items/7` → **HIT**; `E().poll_errors` +1; `sleep(300)` → next GET polls OK (`polls` +1, `poll_errors` unchanged).
  9. **Stats off:** unit-covered (Rust config + entry gate), plus `curl` of `/_brust/cache/epoch` in lane 3's stats-off build if one exists; otherwise skipped with a note.
- [ ] `BRUST_CF_E2E=1 bun test --timeout 900000 tests/cf` → all pass (lane 3/5 files + this one). Without the env → 0 run, exit 0. Commit.

### Task 10 — docs
- [ ] Spec header R5: append "lane 7 landed @<sha>: DO epoch (R1 a), bounded ≤ interval + poll RTT, edge cache → 7b". §5: replace row :332's Workers cell; insert the semantics table after the §5 table; amend the edge-cache row :336 with the R9 facts. §8: a row "Epoch DO: 1 req/poll/isolate/interval; Free 100k req/day …" (from the cost table below). §9 :458: slug/boundary/goal as built, plus a new row `M4-CF-7b m4cf-edge-cache-b`.
- [ ] `examples/pokedex/README.md` + template README: replace lane 5's "stale up to ttl" sentence with "other isolates see it within ~1 s (`epoch_interval_ms`)". `docs/cloudflare.md` if present: the table + the cost table. Commit `docs(m4cf): cross-isolate epoch landed (M4-CF-7)`.

### Task 11 (optional, R12) — real-edge proof (bb rule:cloudflare-account)
- [ ] `tests/cf/edge-proof-epoch.ts`, deploy → probe → delete in `try/finally`; record only commands with `$NAME` expanded, status codes and counts:
  ```sh
  NAME=brust-test-m4cf-edge-cache-$(git rev-parse --short HEAD)
  bunx $WRANGLER deploy -c tests/fixtures/cf-min/dist/cf/wrangler.jsonc --name $NAME > $OUT/edge-deploy.txt 2>&1
  # warm /items/7 over 50 fresh connections (curl --no-keepalive) → mostly HIT
  # POST /_brust/action/bump {"tag":"items"} → 200, t0 = now
  # for 3 s: 50 fresh-connection GETs every 100 ms; per sample (t − t0, x-brust-cache) → $OUT/edge-samples.tsv
  bunx $WRANGLER delete --name $NAME --force        # finally
  ```
- [ ] Report the max (t − t0) of a HIT that predates a re-MISS (expected ≤ 1.5 s). After delete: `bunx $WRANGLER deployments list --name $NAME` exits non-zero, and the URL polls to 404 within 60 s. The delete output must mention the Durable Object namespace. If it does not, or the delete fails → challenge with the name only.

## Acceptance
- **A1:** the clippy line (host, incl. `-p brust-wasm`) and wasm clippy → 0; `cargo test --workspace --exclude bun_react_compiler` → no FAILED; `cargo test -p brust-wasm epoch` → ≥ 15 passed.
- **A2 (native untouched):**
  - `git diff origin/m4cf --stat -- crates/brust-server crates/brust-napi crates/brust-core/src/pipeline.rs crates/brust-core/src/host.rs crates/brust-core/src/cache` → empty;
  - `git diff origin/m4cf -- crates/brust-core/src/core.rs | grep -c '^[+-][^+-]'` → ≤ 3;
  - `git apply --check bench/attribution.patch` → 0;
  - the test-name diff vs `$OUT/names-before.txt` → only `>` lines.
- **A3:** `BRUST_CF_E2E=1 bun test --timeout 900000 tests/cf` → all pass, `cf-epoch.test.ts` 8+ tests. The READY note pastes the summary.
- **A4:** `(cd packages/brust && bun test && bun run typecheck)` → 0 fail. `grep -c 'M4-CF-7b' packages/brust/src/build/config.ts crates/brust-wasm/src/config.rs` → 1 each.
- **A5:** `rg -n 'BRUST_WASM_E2E' crates/brust-wasm/src` → only `option_env!` gates. `rg -n 'storage\(\)' crates/brust-wasm/src/epoch` → empty (R5 default). `rg -n 'unsafe' crates/brust-wasm/src/epoch` → empty.
- **A6:** the release wasm has no e2e routes: `bun crates/brust-wasm/scripts/build.ts --out $OUT/rel && grep -c '__brust_e2e' $OUT/rel/index_bg.wasm` → 0 (`grep -a`).
- **A7 (if Task 11 ran):** the note lists the deploy/delete commands, the max observed staleness, the non-zero `deployments list` exit and the 404; `git grep -nE 'workers\.dev|account_id' -- tests crates npm docs` → empty.

## Gates
- `cargo fmt --all -- --check`; the clippy line above + wasm clippy; `cargo test --workspace --exclude bun_react_compiler`; release `cargo test -p brust-server --release --test single_roundtrip` (`core.rs` was touched).
- `cd packages/brust && bun run build:debug && bun run build && bun run typecheck && bun test`.
- `tests/server/pokedex.test.ts` (native path, after the addon rebuild); `git apply --check bench/attribution.patch`.
- `BRUST_CF_E2E=1 bun test --timeout 900000 tests/cf` (the CI `cf` job runs exactly this).
- Not affected, not run: battery, m2-exit, browser-test, bench (no native hot-path change; do not take `bench:host-lock`).

## Cost and interval trade-off (spec §8; USD as published [C], no THB rate in the source)
One poll = one DO request. Only an isolate that serves a request polls (idle isolates cost nothing). A continuously busy isolate polls `86,400,000 / interval_ms` times a day.

| `epoch_interval_ms` | polls/day per busy isolate | Free (100k DO req/day, account-wide) | Paid, 10 busy isolates, 30 days | staleness bound |
|---|---|---|---|---|
| 250 (min) | 345,600 | exceeded by 1 isolate | 103.7 M → ≈ $15.40 | ≈ 0.25 s + RTT |
| **1000 (default)** | 86,400 | 86% of the quota for 1 isolate | 25.9 M → ≈ $3.74 | ≈ 1 s + RTT |
| 5000 | 17,280 | ≈ 5 busy isolates | 5.2 M → ≈ $0.63 | ≈ 5 s + RTT |
| 60000 (max) | 1,440 | ≈ 69 | 0.43 M → $0 (in the 1 M) | ≈ 60 s + RTT |

- Duration: a DO kept active by polls ≈ 86,400 s/day × 0.128 GB = 11,059 GB-s/day. That is inside the Free 13,000/day and ≈ 331,776/30 days, inside Paid's 400,000 [C].
- Throughput: the soft limit is 1,000 req/s per object [C]. At 1 s that is ~1,000 busy isolates. Past that the DO answers "overloaded", and isolates fail open (≤ `ttl`). The docs must say: Free plan apps with steady traffic should set `epoch_interval_ms ≥ 5000` or `epoch = "off"`.
- Latency: the RTT is to the colo where the DO was first created (it never moves [C]). It is paid by ≤ 1 request per isolate per interval and capped at 500 ms. A location hint (`get_by_name_with_location_hint`) is a non-goal here; note it as a follow-up.

## Risk ledger
- **DO class not exported / not reachable** (worker-build shim, wrangler pin). Task 2 proves it first. `scripts/build.ts` asserts the export on every build, and e2e #1/#2 re-prove it.
- **`exports` vs `migrations`.** Mixing them is a wrangler error [C]. The merge follows the user's style (R8), and tests 3/4 pin it. A user who later moves to `exports` must convert brust's migration too: documented.
- **RefCell across await.** `maybe_sync` and the DO must not hold `EPOCH`/`ring` borrows over `.await`. A `BorrowMutError` panics → lane 3's catch_unwind 500 + `panicked at` in the wrangler output (e2e #3-#8 would show it).
- **Reset storms.** A DO restart (deploy, eviction after global idle) clears every isolate once (R5). It shows as `resets` in `/_brust/cache/epoch`; expected after deploys. If the lead wants no deploy-time clears → R5 alternative.
- **Free-plan quota.** Exhausting it makes polls fail → fail-open (≤ ttl) + `poll_errors`. Documented with the cost table; the warning is rate-limited to 1/60 s.
- **Fire-and-forget publish loss** (R4). If the POST fails twice, other isolates stay stale ≤ ttl. `publish_errors` counts it, plus a `console.error`.
- **Own echo.** The publishing isolate replays its own entry on the next poll: one extra MISS per mutation, harmless (idempotent). Dedupe is a non-goal.
- **D1 read replicas.** If an app enables D1 read replication, a replayed isolate can re-render from a lagging replica and cache it again (≤ ttl). This is the app's consistency choice; document it next to the table.
- **Timing in tests.** Only `sleep(300) > 250 ms` lower bounds; never "HIT within the interval" assertions. On Workers `Date.now()` advances only across I/O (`host.rs:130-133`); each request is new I/O, so `due` is evaluated on the request's arrival time.
- **CONFIG drift** (R7, abi 1). An old core-cf with a new brust fails at wrangler deploy ("BrustEpoch not exported") or at boot (`deny_unknown_fields` on `epoch`). Both sides land together on m4cf; R7's alternative makes it a build error.
- **Shared host.** Kill only spawned PIDs; probe ports per run (lane 3 harness). Task 11 deletes in `finally` and escalates a failed delete at once.

## Reporting
`conclave task note 838f12fb-70c1-41b7-acf2-d4065cf6bb64 m4cf-edge-cache READY @<sha> …`. The note must contain:
- the commit list and R1-R12 as implemented;
- `$OUT/spike.md` (DO export line, `migrations` ok, `exports` ok/not, wrangler pin);
- A1-A7 outputs; the e2e summary (cf-epoch N/N + the other `tests/cf` files); the wasm raw/gzip size before → after;
- the `/_brust/cache/epoch` JSON after e2e #8;
- every gate with its result;
- if Task 11 ran: the deploy/delete commands, the max observed staleness, and the post-delete exit code and 404;
- the line "native path: `pipeline.rs`/`host.rs`/`cache/**` untouched; core = `l1` visibility + `InvalidateArgs` derives".

Escalate with `conclave task challenge 838f12fb-70c1-41b7-acf2-d4065cf6bb64 m4cf-edge-cache "<what, evidence>"` when:
- Task 2 cannot reach the DO class;
- the pinned wrangler rejects both declaration styles;
- any change is needed in `pipeline.rs`, `host.rs`, `cache/**` or `crates/brust-server/**`;
- an existing assertion must change (lane 3's `edgeCache` test message is the one expected exception: "M4-CF-7" → "M4-CF-7b", listed here so it is pre-approved);
- a Task 11 delete fails;
- a file is outside the Boundary.
