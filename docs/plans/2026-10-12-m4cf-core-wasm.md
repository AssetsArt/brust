# m4cf-core-wasm: `brust-core` checks for wasm32-unknown-unknown; single-thread `LocalL1`/`LocalJobs` pass one F81/F86/F89 conformance suite shared with the native caches
**RULED by lead Detoro 2026-10-12 (before dispatch): R1-R14 ALL ACCEPTED as their defaults — hand-rolled LRU (HashMap + BTreeMap recency), lazy TTL on read + ≤ 8-entry sweep per insert + full reap in `stats()`, capacities 256 L1 / 512 jobs + 8 MiB L1 body cap (the brief's 64/256 is the alternative, not taken), no gzip variants (spec R13), fixed hasher, `JsClock` on `js_sys::Date::now()` clamped monotonic (js-sys wasm32-only, no `unsafe-eval`, brust-core never depends on `worker`), fail-loud on wasm: `Manifest::load` compiled out and `env()` in a cache key is a parse error, conformance suite (37 cases) behind the `conformance` feature run against native first then local with identical test-name lists, F89 "page stays out of L1" covered at cache level, boundary widened per R14 (brust-server test hooks, Cargo.lock, ci.yml, attribution.patch regenerated in-lane), CI steps in the existing rust job (target add, check ± default features, clippy on wasm, cargo tree grep incl. parking_lot on both targets), no wasm runtime tests here (lane 3). DISPATCH only after `m4cf-core-split` is merged into `m4cf` (Task 1 ancestry check); same implementer (Dew), reviewer Mellow.**
owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · base: m4cf (after lane/m4cf-core-split @a86d6d4 merges) · lane: m4cf-core-wasm · tier: standard · review: complex
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

This is lane M4-CF-2 of `docs/design/2026-10-12-m4-cloudflare-workers-design.md`. Read these parts first:
- the header (R1-R14);
- §3: the `cache/local.rs` row at :148;
- §4: the `host.rs` block at :184-233;
- §5: the cache table at :327-339;
- §8: the memory row at :431 and the `Instant`/`RandomState` row at :438;
- §9: the lane-2 row at :448: "`crates/brust-core/src/{host,cache/local}.rs`, feature gates | `cargo check -p brust-core --target wasm32-unknown-unknown` green; `LocalL1`/`LocalJobs` pass the shared F81/F86/F89 conformance suite".

Lane 1's plan is `docs/plans/2026-10-12-m4cf-core-split.md`. Its rulings that bind here:
- R2: the moka caches stay in brust-server behind the core traits.
- R4: one `gzip` feature, on by default.
- R5: `Manifest::from_parts` goes to lane 3.
- R8: native-seam items are `doc(hidden) pub`.

Implementer: Dew, who wrote lane 1, F86 and F89. Every `path:line` below was verified at **a86d6d4**. If the base moved, re-anchor on the quoted text.

## Facts the plan rests on
- **The wasm dependency tree is already clean at a86d6d4.** `cargo tree --offline -p brust-core --target wasm32-unknown-unknown -e normal` was run on an export of a86d6d4. It lists blake3 1.8.7 (arrayvec, cfg-if, constant_time_eq; no `cpufeatures` and no `getrandom` on wasm32), brust-jinja, minijinja 3.0.0, serde/serde_json, bytes, flate2 1.1.10 (crc32fast + miniz_oxide, pure Rust), http, matchit, percent-encoding, thiserror and tracing 0.1.44. Nothing matches `tokio|hyper|moka|crossbeam|parking_lot|getrandom`.
- **Adding js-sys keeps it clean (trial on the export).** I added `js-sys = { version = "0.3.106", default-features = false }` as a wasm-only dependency and re-ran the tree. It adds only js-sys 0.3.106 → wasm-bindgen 0.2.129 (+ macro crates, once_cell). In `Cargo.lock` the only change is `"js-sys"` in brust-core's dependency list. js-sys 0.3.106 and wasm-bindgen 0.2.129 are already in the lock (`Cargo.lock:1525,2418`), and 0.2.129 is the version `worker 0.8.7` pins (spec §4). js-sys defaults are `["std","unsafe-eval"]`; `std` pulls `futures-util`. `Date::now` (`js-sys-0.3.106/src/lib.rs:6505`) exists without `std`.
- **What std does on wasm32-unknown-unknown** (source of the pinned nightly-2026-09-15, `library/std/src/sys/…`):
  - `Instant::now` and `SystemTime::now` **panic** (`time/unsupported.rs:12-14,34-36`).
  - `getenv` returns `None` (`env/unsupported.rs:23-25`).
  - `RandomState` keys come from stack and heap addresses, so there is **no panic** (`random/unsupported.rs:7-14`). `fill_bytes` panics, but nothing in the tree calls it.
  - `std::fs` compiles and returns `Unsupported` at runtime.
- **Audit of brust-core at a86d6d4**: the grep below finds no `Instant`, no `SystemTime`, no threads, no `parking_lot`/`crossbeam`, and no RNG. The sites a wasm build touches are:
  1. `manifest.rs:334` `Manifest::load`: `std::fs::read` at :336, `p.is_file()` at :350 and `std::fs::read_to_string` at :384. This is a runtime `Err` on wasm (R9).
  2. `cache/key_expr.rs:188-190`: `"env" => Ok(Expr::Env(std::env::var(…).unwrap_or_default()))`, evaluated once when the route compiles (`routing/routes.rs:166,180`). On wasm it is silently `""` (R9).
  3. `core.rs:62`: `missing_slots: Mutex<HashSet<…>>`. It is locked only in `pipeline.rs:1816-1830` (sync) and `core.rs:175`. On wasm, std's no-threads mutex panics on re-lock, so it must never be held across `.await`. That is already enforced: `lib.rs:18` `#![deny(clippy::all)]` includes the `suspicious` lints `await_holding_lock` and `await_holding_refcell_ref`. No change.
  4. `cache/mod.rs:73-79` (`StripedCounter::incr`, `thread_local!` + `AtomicUsize`) and `inputs.rs:244-245` (`thread_local!` `RefCell<Vec<u8>>` in `job_key`, sync). Both are fine on a no-threads target. No change.
  5. `cache/stamp.rs:6,17,37`, `core.rs:9`: `AtomicU64`/`AtomicU32`/`AtomicUsize` compile on wasm32. `cache/mod.rs:35` `OnceLock` is fine. No change.
  6. `pipeline.rs:10,932,1158,1219,1279,1564,1607` and `core.rs:8`: std `HashMap`/`HashSet` with `RandomState`. Fine, per the std fact above. No change.
  7. `compress.rs:5-10`: `flate2` behind `gzip`. It compiles on wasm. Lane 3 builds `default-features = false` (spec R13).
  8. `pipeline.rs:123,136`: `dur_ms` uses `s.host.now_ns()` (the `Clock` trait, `host.rs:86-92`). There is no `Instant` in core.
  9. `static_rules.rs:48,150`: `std::path::Path` as string logic. Fine.
  10. Test-only `std::fs`/`env!` uses (`pipeline.rs:2295-2326`, `render.rs:695`, `routes.rs:1021`, `config.rs:201`) are host-only.
- **The traits this lane implements** are `host.rs:95-112` `PageCache` and `:115-133` `JobStore`, which take `with_clock(capacity: u64, clock: Arc<InvalClock>)`. Neither trait has a `clear` method. `Core::new` builds both caches on one clock (`core.rs:103,116-117`).
- **Stamp semantics to copy** (native):
  - `l1.rs:389-399` `invalidated_since`: `cleared_at`, the `(method,path)` slot, or any tag slot holds a value `> since.0`.
  - `job_cache.rs` `invalidated_since`: `cleared_at`, the user-key slot, or a tag slot.
  - Slots are `INVAL_SLOTS = 256` (`stamp.rs:33`). Every invalidation takes `clock.next()` (`stamp.rs:26`), and a rejected insert writes nothing.
  - `invalidate_path` returns the number of **live** matches (`l1.rs:495-529`). `invalidate_tags` returns the number of distinct indexed keys.
  - TTL is live iff `now < inserted + ttl`. A ttl past the representable range never expires.
  - `capacity.max(1)`.
- **Native test hooks** the suite needs, all `#[cfg(test)] pub(crate)`:
  - L1: `l1.rs:577` `tag_index_size`, `:583` `tag_slot`, `:589` `path_slot`, `:600` `run_pending`; plus `pub fn clear() -> usize` at `:553`.
  - Jobs: `job_cache.rs:451` `tag_index_size`, `:457` `key_index_size`, `:463` `tag_slot`, `:469` `key_slot`; plus `pub fn clear()` at `:417`.
  - JobCache has **no** `run_pending` hook. Its tests use the private `sync` at `:492-494`, so this lane adds one (test-only).
- **Where the F81/F86/F89 cases live today:**
  - F86 L1: `l1.rs:1099-1200` (10 tests).
  - F89 jobs: `job_cache.rs:938-1068` (10 tests).
  - F81: `tests/l1_concurrency.rs` (threaded: 12 readers vs 300 writer ops; 8 owners × 3000 rounds, caps 64/500, a tag `all` every 50, `clear` ×5).
  - F89 "a rejected job insert keeps the page out of L1" is pipeline code: `pipeline.rs:488-571` `apply_job_results` → `Ok(true)` → no L1 insert. It is covered natively over HTTP by `tests/cache.rs:200`.
- **CI** (`.github/workflows/ci.yml`): toolchain at :20-21, the brust-core tree grep at :37, clippy at :39, `cargo test --workspace` at :44. The dev box has only `aarch64-apple-darwin` installed (`rustup target list --installed`), so Task 1 adds wasm32.
- **`bench/attribution.patch` touches brust-core:**
  - its `Cargo.lock` hunk, `@@ -142,8 +142,11 @@`, has the context lines `"http",` / `"matchit",`;
  - it also has a `Cargo.toml` hunk (`@@ -24,6`, trailing context `[lints]`) and a `lib.rs` hunk (`pub mod perf;`).
  - Adding `"js-sys"` to brust-core's lock entry **breaks the lock hunk's context**, so this lane regenerates the patch (Task 8).
- **Workers time** [C https://developers.cloudflare.com/workers/runtime-apis/performance/, fetched 2026-10-12]: "`performance.now()` and `Date.now()` only advance or increment after I/O occurs". In local development they advance regardless. The page makes no monotonicity claim.

## Goal
- `cargo check -p brust-core --target wasm32-unknown-unknown` and the same with `--no-default-features` are green. `cargo clippy` on the wasm target is green. CI runs both, after `rustup target add wasm32-unknown-unknown`.
- `cargo tree -p brust-core --target wasm32-unknown-unknown -e normal`, with and without default features, contains no `tokio|hyper|moka|crossbeam|parking_lot|getrandom`. The host check (`ci.yml:37`) also greps `parking_lot`. brust-core has no `worker` dependency. `js-sys` is a wasm32-unknown-unknown-only dependency.
- `crates/brust-core/src/cache/local.rs` provides `LocalL1<T: Clock>` and `LocalJobs<T: Clock>`:
  - They implement `PageCache`/`JobStore`.
  - They are single-thread: `RefCell`/`Cell`, no locks, `!Sync` by construction.
  - They evict by LRU on entry capacity, plus an L1 body-byte cap. TTL is measured on the injected `Clock` (ns).
  - They have a tag index, path and user-key invalidation, and an inherent `clear`.
  - They use the same `InvalClock`/`ReadStamp` semantics as the native caches.
  - No `RefCell` borrow outlives a method call. `get_with` runs `f` after the borrow is released.
- `host.rs` provides:
  - `JsClock` (wasm32-unknown-unknown only): `js_sys::Date::now()` behind a monotone guard;
  - `ManualClock` (all targets, doc-hidden): `Rc<Cell<u64>>`, for tests;
  - a host-tested `monotone_ns` helper.
- One conformance suite, `crates/brust-core/src/cache/conformance.rs` (37 cases: L1 17, jobs 18, shared clock 2), runs with identical assertions against `L1Cache`/`JobCache` (in brust-server unit tests) and `LocalL1`/`LocalJobs` (in brust-core unit tests). The two name lists are equal.
- Host behaviour is byte-for-byte unchanged. Every new cfg branch is wasm-only, and every new module is local/test code. No existing assertion changes, and `git apply --check bench/attribution.patch` passes.

## Rulings requested
**R1 — LRU structure.**
- *Default:* hand-rolled, no new dependency. `entries: HashMap<Rc<K>, Entry>` plus `recency: BTreeMap<u64 /*tick*/, Rc<K>>`. A hit moves the entry's tick (O(log n), one `Rc` clone, no key clone; `Rc<K>: Borrow<K>` keeps lookups by `&K`). Eviction pops `recency.first_key_value()`.
- *Alternatives:* a `VecDeque<(Rc<K>, u64)>` with lazy stale pairs and compaction at `len > 2·entries + 64` (O(1) amortised, more invariants), or the `lru` crate (a new dependency, `unsafe` inside).

**R2 — TTL reaping.**
- *Default:*
  - Lazy on read: an expired entry is removed and counted as a miss.
  - A bounded sweep on each insert: inspect at most 8 entries from the LRU tail and drop the expired ones.
  - A full reap in `stats()`, so `len` counts live entries, as the native caches report after `run_pending_tasks`.
  - Memory stays bounded by capacity and bytes whatever the TTLs.
- *Alternative:* an expiry-ordered `BTreeMap<(expires_ns, tick), Rc<K>>` that reaps exactly on every call (a third structure to keep consistent).

**R3 — capacities on Workers.**
- *Default:*
  - `pub const WORKERS_L1_CAPACITY: u64 = 256` and `WORKERS_JOB_CAPACITY: u64 = 512` in `local.rs`. These are spec §4's `[cloudflare] l1_capacity`/`job_cache_capacity` defaults; lane 4 reads `brust.toml`.
  - `pub const L1_MAX_BODY_BYTES: usize = 8 << 20`, applied by `LocalL1::with_clock`. It meets 256 entries at a 32 KiB average page and bounds L1 bodies inside the 128 MB isolate that JS and wasm share (§8 :431).
  - A body larger than the cap is not stored, and `insert` returns `true`, as moka's admission drop does: `false` means "invalidated" and the pipeline logs it so (`pipeline.rs:473-481`).
  - Jobs are bounded by entries only: a `Node` has no cheap size.
  - There is no `CoreConfig` field now. The inherent `LocalL1::with_limits(cap, max_bytes, inval, time)` exists for lane 3/4.
- *Alternatives:* the brief's 64 L1 / 256 jobs; or a `CoreConfig::l1_max_bytes` field plus a `PageCache::with_limits` default method now (touches `core.rs`).

**R4 — gzip variants.**
- *Default:* `LocalL1` accounts `html.len()` only. On Workers brust-core is built without `gzip` (spec R13), so `cached_body` (`pipeline.rs:639-643`) fills `RenderedBody::gzip` with `None`; no variant is ever made. The module docs state that a gzip-enabled wasm build would exceed the byte cap by the lazily made variants.
- *Alternative:* count the gzip as well. This cannot be done at insert, because the variant is filled later, outside the cache.

**R5 — the wasm `Clock`.**
- *Default:* `JsClock` reads `js_sys::Date::now()` (ms f64): `ns = (ms * 1e6) as u64`, clamped by `monotone_ns(&self.last, ms)` so it never goes backwards. NaN or negative input returns `last`.
  - It lives in `host.rs` under `cfg(all(target_arch = "wasm32", target_os = "unknown"))`.
  - The dependency is `[target.'cfg(all(target_arch = "wasm32", target_os = "unknown"))'.dependencies] js-sys = { version = "0.3.106", default-features = false }`. That leaves out `unsafe-eval`, which Workers disallows after startup, and `futures-util`.
  - Why `Date.now`: it is in js-sys with no extra binding. On Workers `performance.now()` has the same I/O-gated advance [C], so it buys no precision. Workers TTLs are therefore coarse within one request (spec §5 :332, harmless).
  - The `worker` crate stays out of brust-core.
- *Alternative:* `performance.now()` via `js_sys::Reflect` on `globalThis.performance` (reflection per call) or via `web-sys` (a new dependency).

**R6 — hasher for the local maps and stamp slots.**
- *Default:* a fixed `BuildHasherDefault<DefaultHasher>` (spec §8 :438). Slots are reproducible in tests, and colliding keys are harmless: maps are bounded by capacity (≤ 512), so the worst case is O(capacity) per call in one isolate.
- *Alternative:* `RandomState`. It works on wasm (address-derived keys) but makes no attacker-relevant difference at these sizes.
- The core pipeline's own `HashMap`s stay `RandomState`.

**R7 — where the suite lives.**
- *Default:* `crates/brust-core/src/cache/conformance.rs`, `#[doc(hidden)] pub`, compiled under `cfg(any(test, feature = "conformance"))`. The new feature is `conformance = []`.
  - It defines `ConformL1: PageCache { fn clear(&self) -> usize; fn tag_slot(&self, &str) -> usize; fn path_slot(&self, &str, &str) -> usize; fn tag_index_size(&self) -> usize; fn settle(&self) {} }` and `ConformJobs: JobStore { fn clear(&self); fn tag_slot; fn key_slot; fn tag_index_size; fn key_index_size; fn settle(&self) {} }`.
  - Each case is a generic `pub fn case<C: ConformL1>(make: &dyn Fn(u64, Arc<InvalClock>) -> C)`. The `#[macro_export]` macros `page_cache_conformance!`, `job_store_conformance!` and `shared_clock_conformance!` expand to one `#[test]` per case, so both crates list identical names.
  - brust-server gets `[dev-dependencies] brust-core = { workspace = true, features = ["conformance"] }`.
- *Alternative:* the suite as a brust-server `#[cfg(test)]` module only. No feature is needed, but the contract then lives far from `host.rs`, and `cargo test -p brust-core` does not run it.

**R8 — F89 "a rejected job insert keeps the page out of L1".**
- *Default:* covered at the cache level by the shared-clock cases.
  - A job insert stamped before `invalidate_user_key` returns `false` on one `InvalClock` shared with an L1.
  - Either cache's `read_stamp` advances on the other's invalidation.
  - The pipeline branch (`apply_job_results` → `Ok(true)`) is host-agnostic code already monomorphised and covered natively (`tests/cache.rs:200`). Lane 3's fixture runs it on `WasmHost`.
- *Alternative:* a core-level `Core<TestHost>` test over the fixture manifest with local caches. It needs a canned loader/jobs host, about 150 lines.

**R9 — wasm-only semantic gates.**
- *Default:*
  - (a) `Manifest::load` gets `#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]`, so a wasm caller gets a compile error, not a runtime `Unsupported`. Its helpers become cfg'd if clippy reports them dead on wasm.
  - (b) On wasm32-unknown-unknown, `env(...)` in a cache expression is a **parse error**: `cache expression: env('X') is not available on Cloudflare Workers (no process env); use a literal`. Route compile then fails `Core::new` loudly instead of baking `""` into every key. The host branch is unchanged.
- *Alternative:* leave both alone (runtime `Err`, silent `""`) and document them.

**R10 — locks.**
- *Default:* brust-core stays free of `parking_lot` on every target. The only lock is std `Mutex` at `core.rs:62`, which is never held across `.await` (enforced by `deny(clippy::all)`). All locking lives in the brust-server impls. CI greps `parking_lot` on host and wasm.
  - Note: `bench/attribution.patch` adds `parking_lot` to brust-core (lane-1 R11, patch-only, never applied in CI).
- *Alternative:* allow `parking_lot` on host-only paths behind `cfg(not(wasm32))`.

**R11 — CI shape.**
- *Default:* new steps in the existing `rust` job after `ci.yml:39`, sharing its cache. The `cargo test --workspace` at :44 already runs the conformance suite in both crates.
  1. `rustup target add wasm32-unknown-unknown`
  2. `cargo check -p brust-core --target wasm32-unknown-unknown`
  3. `cargo check -p brust-core --target wasm32-unknown-unknown --no-default-features`
  4. `cargo clippy -p brust-core --target wasm32-unknown-unknown --no-default-features --no-deps -- -D warnings`
  5. `! cargo tree -p brust-core --target wasm32-unknown-unknown -e normal | grep -E 'tokio|hyper|moka|crossbeam|parking_lot|getrandom'`
  6. `:37` += `|parking_lot`

  `rust-toolchain.toml` stays untouched, so other jobs do not download the target.
- *Alternative:* a separate `wasm` job (a cold cache: about +3 min wall), or `targets = ["wasm32-unknown-unknown"]` in `rust-toolchain.toml`.

**R12 — wasm runtime tests.**
- *Default:* none in this lane; check only. `monotone_ns` (all of `JsClock`'s logic apart from one js call) is unit-tested on the host. Lane 3's workerd fixture is the first wasm runtime.
- *Alternative:* `wasm-bindgen-test` plus `wasm-bindgen-test-runner` on node, which adds a dev-dependency and a CI runner install.

**R13 — dependency features.**
- *Default:* blake3 keeps default features. It is portable on wasm32; its tree has no `getrandom`, and no `wasm32_simd` is needed. `tracing` stays: it compiles on wasm, and events are no-ops until lane 3 installs a subscriber.
- *Alternative:* `blake3/wasm32_simd` (requires a simd128 target feature on Workers, unverified).

**R14 — boundary beyond spec §9.**
- *Default:* the boundary grows by:
  - the test-only hooks plus the conformance wiring in `crates/brust-server/src/cache/{mod.rs,job_cache.rs}`;
  - the brust-server `Cargo.toml` dev-dependency;
  - `Cargo.lock`, `.github/workflows/ci.yml`, `bench/attribution.patch`;
  - a dated status line in the spec.
- *Alternative:* the lead applies the CI and patch edits at merge.

## Boundary
- `crates/brust-core/{Cargo.toml,src/lib.rs,src/host.rs,src/manifest.rs,src/cache/{mod.rs,key_expr.rs,local.rs(new),conformance.rs(new)}}`
- `crates/brust-server/Cargo.toml` (one dev-dep line); `crates/brust-server/src/cache/mod.rs` (a `#[cfg(test)] mod conformance`); `crates/brust-server/src/cache/job_cache.rs` (one `#[cfg(test)] pub(crate) fn run_pending`). No non-test brust-server code changes.
- `Cargo.lock`, `.github/workflows/ci.yml`, `bench/attribution.patch`, `docs/design/2026-10-12-m4-cloudflare-workers-design.md` (Task 9 only)
- NOT in the boundary: `crates/brust-core/src/{pipeline,core,render,routing,…}.rs`, `crates/brust-napi/**`, `packages/**`, `rust-toolchain.toml`. Anything else goes through `conclave task challenge`.

## Tasks
Every task ends green on:
- `cargo fmt --all -- --check`
- `cargo clippy -p brust-core -p brust-compiler -p brust-compiler-cli -p brust-jinja -p brust-server -p brust-napi --no-deps -- -D warnings`
- `cargo test -p brust-core -p brust-server`
- from Task 3 on: `cargo check -p brust-core --target wasm32-unknown-unknown`

`OUT=/tmp/m4cf-core-wasm` (never committed). Commit per task (`feat(core): …`, `test(core): …`, `ci: …`).

### Task 1 — worktree, toolchain, baseline
- [ ] `git -C /Users/detoro/code/brust fetch origin m4cf && git -C /Users/detoro/code/brust worktree add /Users/detoro/code/brust-lane-m4cf-core-wasm -b lane/m4cf-core-wasm origin/m4cf && cd /Users/detoro/code/brust-lane-m4cf-core-wasm && git merge-base --is-ancestor a86d6d4 HEAD && echo base-ok` → `base-ok`. If it does not print `base-ok`, lane 1 is not merged yet: stop and run `conclave task challenge`.
- [ ] `bun install --frozen-lockfile && (cd packages/brust && bun run build:debug)` → exit 0.
- [ ] `rustup target add wasm32-unknown-unknown` (it installs for the toolchain in `rust-toolchain.toml`) → `installed` or `up to date`.
- [ ] `mkdir -p $OUT && cargo test -p brust-core -p brust-server 2>&1 | tee $OUT/t1.txt | grep -c '^test result: ok'`. Note the count; `grep FAILED $OUT/t1.txt` → empty.
- [ ] Name baseline: `(cargo test -p brust-core --lib --tests -- --list; cargo test -p brust-server --lib --tests -- --list) 2>/dev/null | grep ': test$' | sed 's/: test$//' | sort > $OUT/names-before.txt`.
- [ ] `cargo check -p brust-core --target wasm32-unknown-unknown 2>&1 | tail -3 | tee $OUT/wasm-t1.txt`. Expected [I]: `Finished`, because the audit found no compile-time blocker. Any error listed here is added to Task 3's list and noted in READY.
- [ ] `cargo tree -p brust-core --target wasm32-unknown-unknown -e normal | grep -cE 'tokio|hyper|moka|crossbeam|parking_lot|getrandom'` → `0`. `git apply --check bench/attribution.patch` → exit 0.

### Task 2 — `Clock` impls (`host.rs`) + js-sys
- [ ] **Test first** (`host.rs` `#[cfg(test)] mod tests`). It fails to compile until the impls exist.
  - `monotone_never_goes_back`: `last=0`, then 5.0 ms → 5_000_000; 3.0 → 5_000_000; NaN → 5_000_000; -1.0 → 5_000_000; 7.5 → 7_500_000.
  - `manual_clock_is_shared_by_clones`: `let a = ManualClock::default(); let b = a.clone(); b.advance(Duration::from_secs(2)); assert_eq!(a.now_ns(), 2_000_000_000)`.
- [ ] `#[doc(hidden)] pub fn monotone_ns(last: &Cell<u64>, ms: f64) -> u64`. `#[doc(hidden)] #[derive(Clone, Default)] pub struct ManualClock(Rc<Cell<u64>>)` with `advance(Duration)` and `set_ns(u64)`, plus `impl Clock`.
- [ ] `#[cfg(all(target_arch = "wasm32", target_os = "unknown"))] #[derive(Default)] pub struct JsClock { last: Cell<u64> }`, with `impl Clock { fn now_ns(&self) -> u64 { monotone_ns(&self.last, js_sys::Date::now()) } }`. Its doc cites [C] (frozen between I/O) and R5.
- [ ] `crates/brust-core/Cargo.toml`: append the R5 target section **after** `[lints] workspace = true`, so the attribution hunk's trailing context (`[lints]`) still matches. Under `[features]`, add `conformance = []` with the comment `# test-only: exports cache::conformance (brust-server dev-dep)`.
- [ ] `cargo check -p brust-core --target wasm32-unknown-unknown` → `Finished`. `cargo test -p brust-core host::tests` → `2 passed`. Commit.

### Task 3 — wasm gates (R9) + CI-equivalent checks green locally
- [ ] **Test first:** `key_expr::tests::env_is_unavailable_on_workers` calls the extracted host-callable helper `env_unavailable(name) -> String` (the message). It asserts that the message contains `env('X')` and `Cloudflare Workers`. The wasm branch of `"env"` returns `Err(env_unavailable(&name))`; the host branch is the existing code at `:188-190`, unchanged.
- [ ] `manifest.rs:334`: add the R9a cfg to `load`. Then:
  - `cargo clippy -p brust-core --target wasm32-unknown-unknown --no-default-features --no-deps -- -D warnings`. Any dead-code finding is cfg'd the same way, never `allow`ed.
  - `cargo check -p brust-core --target wasm32-unknown-unknown` and the same with `--no-default-features` → both `Finished`.
- [ ] `lib.rs` module doc: replace the sentence at :15-16 ("`Manifest::load` … fails there at runtime") with: wasm32-unknown-unknown builds have no `Manifest::load` (lane 3: `from_parts`); `env()` is a parse error there; time comes from `host::Clock` (no `Instant` anywhere in core: `Instant::now` panics on wasm32-unknown-unknown).
- [ ] `rg -n 'Instant|SystemTime|thread::spawn|parking_lot|crossbeam' crates/brust-core/src` → only doc comments. Commit.

### Task 4 — the conformance suite, green against the NATIVE caches first
- [ ] `crates/brust-core/src/cache/conformance.rs` holds the R7 traits, helpers (`rb_of`, `key`, `tags`, `val(serde_json::Value) -> Arc<Node>`, `TTL = 60 s`) and the 37 cases below. Assertions are copied verbatim from the cited native tests: `html(&c,&k)` becomes `c.get_with(&k, |b| b.html.clone())`, `c.run_pending()`/`sync(&c)` becomes `c.settle()`, and `L1Cache::new()` becomes `make(1000, Arc::default())`. No sleeps and no threads.
  - **L1 (17)**, from `l1.rs`:
    - `get_with_runs_the_closure_once_and_only_on_a_hit` (:1073);
    - the 9 F86 tests at :1099-1200, same names;
    - `invalidate_path_counts_live_matches_across_queries` (:727);
    - `invalidate_tags_counts_distinct_keys_and_prunes_the_index` (:781 + `tag_index_size()==0`);
    - `invalidate_and_clear_preserve_hits_and_misses` (:868);
    - `reinsert_keeps_newer_entry_tag_indexed` (:901, both inserts at TTL; no sleep);
    - `capacity_bounds_len_and_never_serves_a_foreign_body` (cap 10, 200 inserts, `settle`, `stats().len <= 10`, every readable key holds its own body);
    - the F81 pair from `tests/l1_concurrency.rs`, run single-thread:
      - `hot_key_interleaved_with_path_invalidation_ends_consistent`: 300 ops; every 7th op is `invalidate_path`; there are 3 interleaved readers (read after every op: the body index is never above the last insert); same final assertion;
      - `owners_churn_under_capacity_with_tag_invalidation_and_clear`: 8 owners round-robin × 300 rounds at caps 64 and 500; `invalidate_path` every 3rd round, `all` every 50th, `clear` at 5 fixed strides; same assertions.
  - **Jobs (18)**, from `job_cache.rs`:
    - `set_then_get_returns_payload`, `missing_is_none`, `zero_ttl_expires_immediately`, `ttl_none_survives_until_invalidated`, `stats_count_hits_and_misses`, `invalidate_tags_removes_group`, `user_key_invalidates_every_namespaced_entry`, `reinsert_keeps_newer_entry_tag_indexed` (:500-830, sleeps removed);
    - the 10 F89 tests at :938-1068, same names.
  - **Shared clock (2):**
    - `one_clock_a_user_key_invalidation_rejects_a_job_stamped_before_it_and_advances_l1`: `s = l1.read_stamp()`; `jobs.invalidate_user_key("u")`; the job insert with `Some("u")` at `s` is `false`; `l1.read_stamp().0 > s.0`;
    - `one_clock_an_l1_tag_invalidation_rejects_neither_an_untagged_job_nor_an_unrelated_key`.
- [ ] `cache/mod.rs`: `#[cfg(any(test, feature = "conformance"))] #[doc(hidden)] pub mod conformance;`.
- [ ] brust-server:
  - `Cargo.toml` `[dev-dependencies]` += `brust-core = { workspace = true, features = ["conformance"] }`;
  - `job_cache.rs` after `front_len` (:474-477, inside the impl): `#[cfg(test)] pub(crate) fn run_pending(&self) { self.cache.run_pending_tasks(); }`;
  - `cache/mod.rs` after its tests: `#[cfg(test)] mod conformance { impl ConformL1 for L1Cache {…forwards…} impl ConformJobs for JobCache {…} brust_core::page_cache_conformance!(<L1Cache as PageCache>::with_clock); brust_core::job_store_conformance!(<JobCache as JobStore>::with_clock); brust_core::shared_clock_conformance!(…); }`.
- [ ] `cargo test -p brust-server --lib cache::conformance` → `37 passed`. **Any failure here is a suite bug, not a cache bug.** Fix the case, never the native cache; an unexplained native failure becomes a task challenge. Commit.

### Task 5 — `LocalL1` (`cache/local.rs`)
- [ ] **Test first:** in `local.rs` `#[cfg(test)] mod conformance`, implement `ConformL1 for LocalL1<ManualClock>` and invoke `crate::page_cache_conformance!(<LocalL1<ManualClock> as PageCache>::with_clock)`. It is red, because `LocalL1` does not exist.
- [ ] `pub struct LocalL1<T: Clock>`:
  - `{ state: RefCell<L1State>, time: T, inval: Arc<InvalClock>, tag_inval: RefCell<Box<[u64]>>, path_inval: …, cleared_at: Cell<u64>, hits: Cell<u64>, misses: Cell<u64>, capacity: u64, max_bytes: usize, hasher: BuildHasherDefault<DefaultHasher> }`;
  - `L1State { entries: HashMap<Rc<CacheKey>, L1Entry>, recency: BTreeMap<u64, Rc<CacheKey>>, tags: HashMap<String, HashSet<Rc<CacheKey>>>, next_tick: u64, bytes: usize }`;
  - `L1Entry { body: Arc<RenderedBody>, expires_ns: Option<u64>, tags: Box<[String]>, tick: u64, bytes: usize }`.
  - Every removal goes through one `fn remove_locked(&mut L1State, &CacheKey)` that unlinks recency, tag sets (dropping empty sets) and bytes. Removal is synchronous, so no generations are needed. The "reinsert keeps newer entry tag-indexed" case proves it.
- [ ] Methods (R1/R2/R3/R6):
  - `insert`: `invalidated_since` (same three checks as `l1.rs:389-399`) → `false`, nothing written. Otherwise:
    - replace any old entry;
    - if `bytes > max_bytes`, return `true` without storing;
    - sweep ≤ 8 expired entries from the LRU tail;
    - evict LRU while `len > capacity || bytes > max_bytes`;
    - `true`.
  - `get_with`: under one borrow, find the entry; expired → remove, miss; live → bump the tick and clone the `Arc`. **Drop the borrow, then call `f`**.
  - `invalidate_path`: publish `next()` into the slot, then scan; count live matches; remove all matches.
  - `invalidate_tags`: publish into each tag slot, then take the tag sets and remove those keys; return the distinct count.
  - `clear`: `cleared_at = next()`; wipe; return the previous live count.
  - `stats`: full reap, then `{hits, misses, len, capacity}`.
  - `with_clock`: `with_limits(cap.max(1), L1_MAX_BODY_BYTES, inval, T::default())`, which requires `T: Clock + Default`.
  - Module doc: the reentrancy rule ("a single isolate interleaves requests at every `.await`; every method takes and releases its borrows inside the call and returns no guard; `get_with` calls `f` with no borrow held, so `f` may re-enter").
- [ ] `cargo test -p brust-core cache::local::conformance` → `17 passed` (the job and shared macros are still commented). Commit.

### Task 6 — `LocalJobs`
- [ ] **Test first:** `ConformJobs for LocalJobs<ManualClock>` plus `crate::job_store_conformance!` and `crate::shared_clock_conformance!` → red.
- [ ] `LocalJobs<T: Clock>` has the same shape without bytes, plus `users: HashMap<String, HashSet<Rc<JobKey>>>`, `key_inval` slots, `ttl: Option<Duration>` (`None` → `expires_ns: None`) and `user_key` stored per entry. The check is `invalidated_since(tags, user_key, since)`, as in `job_cache.rs`. `invalidate_user_key` publishes into the user-key slot only. TTL ns: `ttl.as_nanos()` saturating to `u64`, then `checked_add`; overflow → never expires.
- [ ] `cargo test -p brust-core cache::local::conformance` → `37 passed`. Commit.

### Task 7 — local-only behaviour tests (`local.rs` `mod tests`, ManualClock, deterministic)
- [ ] `ttl_is_exact_on_the_injected_clock` (L1 and jobs): ttl 30 s; at +29_999_999_999 ns a hit; at +30 s a miss, and `stats().len == 0`.
- [ ] `a_huge_ttl_never_expires`: `Duration::MAX`; advance 10 years; still a hit.
- [ ] `lru_evicts_the_least_recently_read`: cap 3; insert a, b, c; read a; insert d → b gone; a, c, d hit.
- [ ] `the_byte_cap_evicts_lru_and_skips_an_oversize_body`: `with_limits(10, 100, …)`; 4 × 30-byte bodies → the first is evicted; then a 101-byte body → `insert` is `true`, it is absent, and the other 3 are intact.
- [ ] `insert_sweeps_expired_tail_entries`: 5 at ttl 1 s, advance 2 s, insert 1. A `#[cfg(test)] fn raw_len()` → 1.
- [ ] `get_with_closure_may_reenter_the_cache`: inside `f`, call `c.insert(…)` and `c.invalidate_tags(…)` → no panic. Afterwards the insert is visible and the tag invalidation applied.
- [ ] `interleaved_requests_on_one_isolate_keep_f86_f89`: a single-thread poll loop. It uses `std::task::Waker::noop()`, `Context::from_waker` and a hand-written `YieldOnce` future, with no new dependency.
  - Render future A: `s = l1.read_stamp(); YieldOnce.await; l1.insert(k, b, TTL, &["t"], s)`.
  - Action future B: `l1.invalidate_tags(&["t"])`.
  - Order: poll A → `Pending`, run B, poll A → `Ready(false)`, and `get_with` is `None`. Then B before A's stamp → `Ready(true)`.
  - The same pair for `LocalJobs` with `user_key`.
- [ ] `cargo test -p brust-core cache::local` → 37 conformance + 7 local passed. Commit.

### Task 8 — CI + attribution.patch
- [ ] `ci.yml`: add the R11 steps after `:39`. At `:37`, the grep becomes `'tokio|hyper|moka|crossbeam|parking_lot'`.
- [ ] Locally run every new CI command verbatim → exit 0, and capture their output in `$OUT/ci.txt`.
- [ ] `git apply --check bench/attribution.patch`. It is expected to fail on the `Cargo.lock` hunk (context `"http",`/`"matchit",` now has `"js-sys",` between them). Regenerate it as lane 1's T10 did:
  - `git status --short` → clean;
  - `git apply --3way bench/attribution.patch`;
  - resolve the lock list to `"http","js-sys","libc","matchit","minijinja","once_cell","parking_lot",…`;
  - `cargo check -p brust-core -p brust-server -p brust-napi` → exit 0;
  - `git diff HEAD -- Cargo.lock crates packages/brust/src/worker.ts > $OUT/attr.patch && cp $OUT/attr.patch bench/attribution.patch`;
  - `git reset -q HEAD -- Cargo.lock crates packages/brust/src/worker.ts && git checkout -- Cargo.lock crates packages/brust/src/worker.ts && git clean -fq crates/brust-core/src/perf.rs`;
  - guard: `git status --short` → only ` M bench/attribution.patch`; `grep -rn 'mod perf' crates/` → empty; `git apply --check bench/attribution.patch` → exit 0.
- [ ] `(cd packages/brust && bun run build:debug)`. Commit `ci: wasm32 check + tree guard for brust-core; attribution.patch follows js-sys`.

### Task 9 — docs
- [ ] Spec §3: add a status line under :151, "M4-CF-2 done @<sha>: …" (the `local.rs` row; `JsClock`; R9 gates). Spec §5 :329: the L1-scope row's "optional byte weigher" → "`L1_MAX_BODY_BYTES` 8 MiB (lane 2)".
- [ ] `local.rs` module doc names the conformance suite and R2/R3/R4. Commit `docs(m4cf): core-wasm landed`.

## Acceptance
- **A1:** `cargo check -p brust-core --target wasm32-unknown-unknown && cargo check -p brust-core --target wasm32-unknown-unknown --no-default-features && cargo clippy -p brust-core --target wasm32-unknown-unknown --no-default-features --no-deps -- -D warnings` → exit 0.
- **A2:** for `F` in `""` and `--no-default-features`: `cargo tree -p brust-core --target wasm32-unknown-unknown -e normal $F | grep -E 'tokio|hyper|moka|crossbeam|parking_lot|getrandom|worker '` → empty. `cargo tree -p brust-core --target wasm32-unknown-unknown -e normal | grep -c js-sys` → 1. `! cargo tree -p brust-core -e normal | grep -E 'tokio|hyper|moka|crossbeam|parking_lot|js-sys'` (host) → exit 0.
- **A3 (one suite, both impls):** `diff <(cargo test -p brust-core --lib -- --list 2>/dev/null | sed -n 's/.*local::conformance::\(.*\): test$/\1/p' | sort) <(cargo test -p brust-server --lib -- --list 2>/dev/null | sed -n 's/.*cache::conformance::\(.*\): test$/\1/p' | sort)` → empty, and `wc -l` = 37 each. `cargo test -p brust-core cache::local` and `cargo test -p brust-server --lib cache::conformance` → no FAILED.
- **A4:** `git diff origin/m4cf -- crates | grep -E '^-\s*(debug_)?assert'` → empty. The name-list diff against `$OUT/names-before.txt` shows only `>` lines (37 + 37 conformance, 7 local, 2 host, 1 key_expr).
- **A5:** `rg -n 'Instant|SystemTime' crates/brust-core/src` → doc comments only. `rg -n 'pub fn .*-> *(std::cell::)?Ref(Mut)?<' crates/brust-core/src/cache/local.rs` → empty. `rg -n 'js_sys' crates/brust-core/src` → only inside the `cfg(all(target_arch = "wasm32", target_os = "unknown"))` items.
- **A6:** `git diff origin/m4cf --stat -- crates/brust-server` → only `Cargo.toml`, `src/cache/mod.rs`, `src/cache/job_cache.rs`. The diff of the latter two is entirely inside `#[cfg(test)]` items: `git diff origin/m4cf -- crates/brust-server/src | grep '^+' | grep -v '^+++'` is reviewed against that rule.
- **A7:** `git apply --check bench/attribution.patch` → exit 0. `cargo test --workspace --exclude bun_react_compiler` → no FAILED.

## Gates
- `cargo fmt --all -- --check`
- `cargo clippy -p brust-core -p brust-compiler -p brust-compiler-cli -p brust-jinja -p brust-server -p brust-napi --no-deps -- -D warnings`
- `cargo test --workspace --exclude bun_react_compiler`
- the new ones: A1, A2's two `cargo tree` greps, and `rustup target add wasm32-unknown-unknown` in CI
- `git apply --check bench/attribution.patch`
- `cd packages/brust && bun run build:debug && bun run typecheck && bun test`: a sanity check that the host-compiled core is unchanged.
- Not affected: host code is identical, because every non-test change is wasm-cfg'd or a new module that only tests reach. These are pokedex/hydrate e2e, m2-exit, battery, browser-test, runtime-dom, bench apps, `single_roundtrip` and `cargo bench --no-run`. The lead runs them at merge as usual.
- No bench of any kind; do not take `bench:host-lock`.

## Risk ledger
- **blake3's build script on a wasm32 target** [I]: the tree check passed, but a build script can still fail at `cargo check`. Task 1's `wasm-t1.txt` shows it first. If it fails, check whether the error names `cc`/`clang`. The response is a task challenge (feature or version pin), not a vendor patch.
- **Clippy on wasm finds dead code** behind the new cfgs (`Manifest::load` helpers). Response: cfg those helpers too, and never add `#[allow(dead_code)]`. A3 and A1 catch any slip.
- **A suite that is green on local but wrong on native**, or the reverse:
  - Task 4 runs the suite on native **first**, so a red native case means the suite is wrong.
  - moka's TinyLFU admission may drop inserts, so the cases assert "own body or none", never presence, after a capacity fill.
  - Counts are asserted only on live entries (native `invalidate_tags` counts indexed but expired keys).
- **RefCell reentrancy:**
  - A `BorrowMutError` panic on Workers kills the isolate (spec R7 unwind aside).
  - Guards: A5 (no guard escapes), `get_with_closure_may_reenter_the_cache`, the interleaving test, and `deny(clippy::all)` ⊇ `await_holding_refcell_ref`/`await_holding_lock` on pipeline code.
  - The `core.rs:62` mutex is the one remaining lock. It is never held across `.await` (lint).
- **Slot collisions with a fixed hasher** only skip caching one render (native semantics). The tests pick non-colliding names via `tag_slot`/`path_slot`/`key_slot`, as the native tests do.
- **js-sys / wasm-bindgen skew with lane 3**: `worker 0.8.7` needs wasm-bindgen 0.2.129. js-sys 0.3.106 already resolves to it (`Cargo.lock:2418`). A `cargo update` that bumps js-sys would break lane 3's link; A2's `grep -c js-sys` plus the lock diff show it.
- **attribution.patch**: `--3way` stages into the index, so reset before checkout (Task 8). A forgotten `perf.rs` is caught by the guard grep.
- **Stale addon**: rebuild after Rust edits before `bun test`. **Shared host**: never kill a process you did not spawn.

## Reporting
`conclave task note 838f12fb-70c1-41b7-acf2-d4065cf6bb64 m4cf-core-wasm READY @<sha> …`. The note must contain:
- the commit list;
- R1-R14 as implemented;
- `$OUT/wasm-t1.txt` (whether the base already checked green);
- the A1/A2 outputs;
- the A3 diff, which must be empty, with both counts (37);
- the A4 name additions;
- A6's `--stat`;
- every gate with its result;
- the patch regeneration guard output;
- one line: "host build unchanged: all non-test edits are `cfg(all(target_arch=\"wasm32\", target_os=\"unknown\"))` or new modules reached only from tests".

Escalate with `conclave task challenge 838f12fb-70c1-41b7-acf2-d4065cf6bb64 m4cf-core-wasm "<what, evidence>"` for any of these:
- `cargo check` on wasm fails in a dependency;
- a native conformance case fails with the suite verified against the cited native test;
- any change needed to `pipeline.rs`/`core.rs`/`host.rs` trait signatures;
- an existing assertion that must change;
- a file outside the Boundary.
