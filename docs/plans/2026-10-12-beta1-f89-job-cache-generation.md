# beta1-f89-job-cache-generation: job-cache read stamps — a `cache({key})` value computed before an invalidation never lands
**RULED by lead Detoro 2026-10-12 (before dispatch): R1 ACCEPTED — ONE shared clock: `cache/stamp.rs` with `ReadStamp`, `InvalClock` and the 256-slot helper, `Server` owns one `Arc<InvalClock>` and builds both caches on it (`with_clock`); `l1.rs` changes mechanical only. R2 ACCEPTED — uniform check for every job insert (content-keyed included; a false rejection costs one recompute). R3 ACCEPTED — `insert(…, since) -> bool`, debug log per rejection, `CacheStats` untouched, the computed value is still served for that response. R4 ACCEPTED — the stamp is taken unconditionally on every non-HIT page (one SeqCst load on BYPASS/uncached routes; HIT path unchanged); the bench-again row will show it is in the noise. R5 ACCEPTED — a page whose job insert was rejected is NOT stored in L1 either (`cacheable = false`); correctness over caching. R6 ACCEPTED — `invalidate_key(&JobKey)` does not publish; F80 stays out. DISPATCH only after `beta1-f86-l1-generation` is merged into `beta1` (Task 1 checks `git merge-base --is-ancestor 3814744 beta1`) and after the lead has filed the F89 ledger row; until then Dew may do read-only preparation. The bench window rule (bb rule:bench-window) applies: no builds while bench:host-lock is held.**
owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · base: beta1 (after lane `beta1-f86-l1-generation` @3814744 is merged) · lane: beta1-f89-job-cache-generation · tier: complex · review: complex
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Ledger row F89 (`docs/plans/m1a-followups.md`, filed by the lead at the F86 merge), quoted: "`crates/brust-server/src/cache/job_cache.rs` insert + `pipeline.rs` `apply_job_results` | A `cache({key})` job value computed by a call that began before `invalidate({key})`/`({tags})` can be inserted after it and served (and baked into later L1 pages) until its ttl. Content-keyed entries (`inputs::job_key`, a hash of the job's inputs, `pipeline.rs:1515-1532`) are immune; only `k:<cid>/<job>/<user key>` entries are exposed. | Reuse F86's read stamp: tag + user-key slot arrays in `JobCache`, `insert(…, since) -> bool`, the stamp taken once in `page()` before the loader call; test read → invalidate({key}) → insert must not land."

You (Dew) built F86. This lane applies the same mechanism to `JobCache`. All lines below are at `3814744` (`git -C ~/code/brust-beta1 show 3814744:<path>`). Re-anchor on the quoted text if the merge moved them.

## Facts the plan rests on

- **The only production job insert** is in `apply_job_results` (`pipeline.rs:622-688`), at `:673-679`: `s.jobs.insert(p.key.clone(), Arc::clone(&v), p.ttl, p.tags, p.user_key.as_deref());`. The value is still used for this response at `:680`.
- **`apply_job_results` has two callers in `page()`:** the planned path at `:499` (jobs ran inside the loader call; `plan_in_call` looked the cache up on the worker thread) and the unplanned path at `:551` (after `call_worker(… CallKind::Jobs …)` `:522-529`). Loader-less routes (`/`, `/ids`) plan in Rust and take the unplanned path.
- **Other `JobCache::insert` callers:**
  - `pipeline.rs:2214-2220` in `plan_stage::Planned::warm` (bench API, used by `benches/render.rs:340`);
  - `pipeline.rs:3141` (test `plan_response_pins_hits_and_answers_empty_when_all_hit`);
  - 27 calls in `job_cache.rs` `mod tests` (16 tests, `:397-794`).
- **F86 stamp site:** `pipeline.rs:325-328`, `let since = cache_key.as_ref().map(|_| s.l1.read_stamp());`. It sits after the L1 HIT `return` (`:320-323`) and before the envelope and the first worker call (`:374`). It is `None` on a BYPASS or an uncached route. Those routes still run jobs and insert into the job cache, so a job stamp must exist on them too (R4). The L1 insert is at `:603-612`.
- **F86 machinery in `l1.rs`:**
  - `ReadStamp(u64)` at `:195-200`, `INVAL_SLOTS = 256` at `:202-203`;
  - fields `inval_seq`, `tag_inval`, `path_inval` and `cleared_at` at `:313-321`, initialised at `:378-381`;
  - `read_stamp` at `:436-438`, `next_inval` at `:441-443`, `slot` at `:446-448`, `invalidated_since` at `:452-459`;
  - `insert` at `:464-525` checks after the gate and stripe (`:482-493`);
  - `invalidate_tags` publishes under `gate.write()` (`:595-611`); `clear` publishes at `:624-626`;
  - test hooks `tag_slot` and `path_slot` at `:644-654`.
- **`JobCache` today** (`job_cache.rs`):
  - module doc at `:1-13`; struct invariant at `:132-150`; struct at `:151-170`; `new(max_capacity)` at `:173-215`;
  - `get` at `:217-248`, the job HIT path;
  - `insert(k, value, ttl: Option<Duration>, tags: &[String], user_key: Option<&str>)` at `:252-306`: gate read `:266`, stripe `:273`, `next_generation` `:274`, `index_tags` ×2 `:275-276`, `mid_insert` hook `:277-280`, front `:285-296`, moka `:297-305`;
  - `invalidate_key(&JobKey)` at `:318-320` (no production caller), `invalidate_tags` at `:324-326`, `invalidate_user_key` at `:330-332`, both through `invalidate_indexed` (`:334-342`, `gate.write()`);
  - `clear` at `:344-360` (no production caller); `stats` at `:362-371` returns the shared `CacheStats`.
- **Invalidation path:**
  - JS `cache.invalidate(args)` (`packages/brust/src/cache.ts:11-23`) → napi `cache_invalidate` (`crates/brust-napi/src/server.rs:284-297`) → `Server::invalidate` (`crates/brust-server/src/config.rs:294-308`);
  - `key` → `jobs.invalidate_user_key`; `tags` → `l1.invalidate_tags`, then `jobs.invalidate_tags`; `path` → L1 only.
  - The doc at `config.rs:289-293` already says L1 pages built from an invalidated job value are not evicted by `key`. `docs/design/brust-core-port.md:69` lists this as a known limit.
- **Both caches live in `Server`** (`config.rs:232-233`). They are built only at `server/mod.rs:135-136` (`L1Cache::with_capacity`, `JobCache::new`).
- **Test fixture:**
  - `moveCard_d4` job `j0` is content-keyed, `tags: ["moves"]`, `ttl_seconds: 30`; `detailPage_c3` `j0` is content-keyed and untagged (`tests/fixtures/dist/manifest.json`).
  - `review_fixes.rs:145-174` shows how to set `cache.key` through `temp_dist`.
  - `FakeBun`'s `jobs` responder runs on both paths: `boot_in` binds the fake (planned path), and an unbound fake takes the unplanned path (`single_roundtrip.rs:67-72` `boot_declining`).
  - `default_job` (`tests/common/mod.rs:46-73`) answers moveCard with `{"_s1": "MOVE <name>"}`.

## Goal

- A job-cache insert carries the request's read stamp. It does not land if a covering invalidation took a sequence number after the stamp. A covering invalidation is `invalidate_user_key` of its user key (by slot), `invalidate_tags` of one of its tags (by slot), or `clear`.
- read → `invalidate({key})` → insert: no entry. The next page that needs that job recomputes it, and the recomputed value then caches. The same holds for `invalidate({tags})`. A unit test covers it, and so does an HTTP test on both the planned and the unplanned path.
- read → insert → invalidate still evicts. invalidate → read → insert lands. An unrelated user key or tag does not reject. A rejected insert leaves a newer entry alone.
- One `ReadStamp` per non-HIT page, taken where F86 takes it, guards both caches (R1, R4).
- The L1 HIT path (`get_with`, the probe at `pipeline.rs:305-324`) and the job HIT path (`JobCache::get`, `lookup_jobs`) are byte-for-byte unchanged. `CacheStats` is unchanged (R3).
- The `job_cache.rs` module docs and struct invariant state the read-stamp rule. The F89 ledger cell reads `DONE 2026-10-xx — …`.

## Rulings requested

**R1: one shared clock, or one per cache?** *Recommended: shared.*
- New module `crates/brust-server/src/cache/stamp.rs` holds three items:
  - `ReadStamp`, moved from `l1.rs`;
  - `pub struct InvalClock(AtomicU64)` (Default) with `pub fn stamp(&self) -> ReadStamp` (SeqCst load) and `pub(crate) fn next(&self) -> u64` (SeqCst `fetch_add(1)+1`);
  - `INVAL_SLOTS` and `pub(crate) fn inval_slots() -> Box<[AtomicU64]>`.
- `L1Cache` replaces `inval_seq` with `clock: Arc<InvalClock>` and gains `with_clock(cap, clock)`. `with_capacity` calls it with a fresh clock, so no test changes. `JobCache` mirrors this with `new` and `with_clock`.
- `Server` gets `pub(crate) clock: Arc<InvalClock>`. `server/mod.rs` builds both caches on it. `page()` takes `s.clock.stamp()`.
- The `l1.rs` change is mechanical. Every F86 test stays as is.
- Why shared: one type and one load per page. A stamp cannot be valid for one cache and wrong for the other, which matters because with two seqs an L1 `ReadStamp` passed to `jobs.insert` would compile and be silently wrong.

*Alternative:* `JobCache` gets its own `inval_seq` and a distinct `JobReadStamp` type (it must be distinct, for that reason). `page()` takes two stamps. `l1.rs`, `config.rs` and `server/mod.rs` stay untouched. This costs one extra SeqCst load per page and a second concept.

**R2: do content-keyed inserts skip the check?** *Recommended: no, one uniform check.*
- Every insert checks `cleared_at`, its tags' slots, and its user key's slot when it has one. An untagged content-keyed insert therefore pays one load (`cleared_at`).
- `invalidate({tags})` means "values tagged t computed before now are stale". The immunity argument assumes the job is a pure function of its hashed inputs. A tagged content-keyed job is exactly the case where the app says it is not: the fixture's `moveCard_d4` carries `tags: ["moves"]`.
- A rejection costs one recompute on the next miss.

*Alternative:* skip the check when `user_key.is_none()`, which saves that recompute under racing tag invalidations.

**R3: is a rejection observable?** *Recommended:*
- `JobCache::insert(…, since: ReadStamp) -> bool`.
- `apply_job_results` logs each rejection: `tracing::debug!(target: "brust::cache", route = %route.id, component_id = %p.component_id, job_id = %p.job_id, "job cache insert skipped: invalidated during the call")`.
- The value is still used for this response.
- No `CacheStats` field: it is shared with L1 and serialized as `/_brust/cache/stats`.

*Alternative:* a `rejected` counter in `CacheStats` for both caches, plus docs.

**R4: where and when the stamp is taken.** *Recommended:* unconditionally, at the F86 site. `let since = s.clock.stamp();` replaces `pipeline.rs:328`.
- The L1 insert clause drops `&& let Some(since) = since`.
- A HIT still returns before the stamp.
- A BYPASS or uncached page now does one SeqCst load: a plain `mov` on x86-64, `ldar` on aarch64. F86's "BYPASS runs no new instruction" note is retired.

*Alternative:* stamp only when `cache_key.is_some() || s.plans.chain_has_jobs(&route.chain)` (`pipeline.rs:1445`). That is a branch plus a map walk to save one load.

**R5: does a rejected job insert also keep that page out of L1?** *Recommended: yes.*
- `apply_job_results` returns `Ok(true)` when any insert was rejected, and `page()` then sets `cacheable = false`.
- Without it, the page that raced the invalidation lands in L1 with the stale value for the route ttl. The job cache stops serving the value, but L1 keeps serving that one page.
- L1 pages rendered before the invalidation stay cached. That is the documented known limit (`config.rs:289-293`, `brust-core-port.md:69`) and is not in scope.

*Alternative:* leave L1 alone and keep `Result<(), _>`.

**R6: `invalidate_key(&JobKey)` and ledger F80.** *Recommended:*
- `invalidate_key` has no production caller, so it does not publish. Its doc says so.
- F80 (extract `StripedCounter`, "when either cache is next touched") stays out of this lane, so the review surface stays the stamp.

*Alternative:* a third slot array hashed by `JobKey`, and/or fold F80 into `stamp.rs`'s sibling module.

## Boundary

- `crates/brust-server/src/cache/stamp.rs` (new), `cache/mod.rs` (`pub mod stamp;`).
- `cache/l1.rs`: R1 mechanics only. Move `ReadStamp`/`INVAL_SLOTS`, swap `inval_seq` for `clock`, add `with_clock`, update the doc wording `inval_seq` → clock. No logic change.
- `cache/job_cache.rs`.
- `src/pipeline.rs`: in `page()`, `:325-328`, the call sites `:499` and `:551`, the L1 insert clause `:603-612`. Also `apply_job_results` `:616-688`, `plan_stage::Planned::warm` `:2211-2221`, and the test at `:3141`.
- `src/config.rs`: the `Server` field, plus one sentence in the `invalidate` doc `:289-293`.
- `src/server/mod.rs` `:135-136`.
- `crates/brust-server/tests/cache.rs` (one new test).
- `docs/plans/m1a-followups.md` (F89 cell only).

Not touched: napi, `packages/*`, `benches/render.rs` (`warm` keeps its signature), `tests/l1_concurrency.rs`, `tests/l1_front.rs`, `tests/single_roundtrip.rs`. Shared host: kill only PIDs you spawned. If R1 = separate, drop `stamp.rs`, `mod.rs`, `l1.rs`, `config.rs` and `server/mod.rs` from the Boundary.

## Tasks

### Task 1: Lane, baseline
- [ ] `git -C ~/code/brust fetch origin && git -C ~/code/brust merge-base --is-ancestor 3814744 origin/beta1 && echo F86-IN`. Expected: `F86-IN`. If it is missing, `task challenge` and stop.
- [ ] `grep -n "^| F89 " docs/plans/m1a-followups.md` (after the worktree exists). Expected: one row. If it is missing, `task challenge`.
- [ ] `cd ~/code/brust && git worktree add ~/code/brust-lane-beta1-f89-job-cache-generation -b lane/beta1-f89-job-cache-generation origin/beta1 && cd ~/code/brust-lane-beta1-f89-job-cache-generation && bun install --frozen-lockfile && (cd packages/brust && bun run build:debug)`. Expected: exits 0.
- [ ] `cargo test -p brust-server --lib cache::` and `cargo test -p brust-server --lib pipeline::`. Expected: `0 failed`. Record the counts; `cache::job_cache` is 16.
- [ ] `cargo test -p brust-server --test cache --test review_fixes --test plan_offer --test store_job_keys` and `cargo test -p brust-server --release --test single_roundtrip -- --nocapture`. Expected: all `ok`.
- [ ] Save the HIT-path baselines:
  - `sed -n '/pub fn get(&self, k: &JobKey)/,/^    }$/p' crates/brust-server/src/cache/job_cache.rs > /tmp/f89-jobget.before`
  - `sed -n '/pub(crate) fn lookup_jobs/,/^}$/p' crates/brust-server/src/pipeline.rs > /tmp/f89-lookup.before`
  - `sed -n '/pub fn get_with/,/^    }$/p' crates/brust-server/src/cache/l1.rs > /tmp/f89-getwith.before`
  - `sed -n 305,324p crates/brust-server/src/pipeline.rs > /tmp/f89-probe.before`

### Task 2: Shared clock + stamped insert, no behaviour change (R1, R4)
- [ ] Create `stamp.rs` with `ReadStamp` (keep the F86 doc, now naming both caches), `InvalClock`, `INVAL_SLOTS` and `inval_slots()`. `ReadStamp`'s field becomes `pub(crate) u64` so both caches can compare it (it stays opaque outside the crate).
- [ ] In `l1.rs`:
  - replace the field `inval_seq: AtomicU64` with `clock: Arc<InvalClock>`;
  - `read_stamp` becomes `self.clock.stamp()`, and `next_inval` becomes `self.clock.next()`;
  - add `pub fn with_clock(max_capacity: u64, clock: Arc<InvalClock>) -> Self`, the current body; `with_capacity(c)` becomes `Self::with_clock(c, Arc::default())`;
  - add `pub use super::stamp::ReadStamp;` so `cache::l1::ReadStamp` keeps resolving.
- [ ] In `job_cache.rs`:
  - add the fields `clock: Arc<InvalClock>`, `tag_inval: Box<[AtomicU64]>`, `key_inval: Box<[AtomicU64]>` and `cleared_at: AtomicU64`;
  - add `with_clock` (`new(c)` = `with_clock(c, Arc::default())`), `pub fn read_stamp(&self) -> ReadStamp`, and `fn slot<T: Hash + ?Sized>(&self, v: &T) -> usize` (`self.hasher.hash_one(v) as usize % INVAL_SLOTS`);
  - add the test hooks `tag_slot(&str)` and `key_slot(&str)`;
  - change the signature to `pub fn insert(&self, k: JobKey, value: Arc<Node>, ttl: Option<Duration>, tags: &[String], user_key: Option<&str>, since: ReadStamp) -> bool`. It still always lands and returns `true`.
- [ ] Update the callers to pass `c.read_stamp()`/`s.read_stamp()`/`cache.read_stamp()`:
  - the 27 test inserts; in `invalidate_between_index_and_insert_is_not_lost` (`:764-793`), take the stamp inside the spawned thread;
  - `warm` (`:2214`);
  - the test at `:3141`.
- [ ] `config.rs`: add `pub(crate) clock: Arc<crate::cache::stamp::InvalClock>` to `Server`. `server/mod.rs:135-136`: build `let clock = Arc::new(InvalClock::default());`, then `L1Cache::with_clock(cfg.l1_capacity, Arc::clone(&clock))`, `JobCache::with_clock(cfg.job_cache_capacity, Arc::clone(&clock))` and `clock`.
- [ ] `pipeline.rs`:
  - `:328` becomes `let since = s.clock.stamp();`. Update the comment above it: one stamp for both caches, taken on every non-HIT page.
  - The L1 clause at `:603-612` drops `&& let Some(since) = since`.
  - `apply_job_results` gains `since: ReadStamp` as its last parameter, and both call sites pass `since`.
  - The insert at `:673` ignores the returned bool for now (`let _ =`).
- [ ] Run `cargo test -p brust-server --lib && cargo bench -p brust-server --bench render --no-run`. Expected: 0 failed; the bench builds. Commit `refactor(server): one invalidation clock for L1 and the job cache; job insert takes a read stamp (F89, no behaviour change)`.

### Task 3: Red tests first
- [ ] In `job_cache.rs` `mod tests`, write these tests (ttl `None`, value `Arc::new(Node::from(json!(…)))`):
  1. `invalidate_user_key_after_the_read_stamp_keeps_the_insert_out`:
     - `let s0 = c.read_stamp(); assert_eq!(c.invalidate_user_key("u"), 0);`
     - `assert!(!c.insert(k("k:a/j0/u"), v, None, &[], Some("u"), s0));`
     - `get` is `None`; after `sync`, `(front_len, key_index_size, tag_index_size, stats().len) == (0,0,0,0)`.
  2. `a_tag_invalidation_after_the_read_stamp_keeps_the_insert_out`: the same, with tags `["t"]` and `invalidate_tags(["t"])`.
  3. `an_insert_before_the_invalidation_is_still_evicted`: stamp → insert `true` → `invalidate_user_key("u") == 1` → `None`.
  4. `a_stamp_after_the_invalidation_lands`: invalidate → stamp → insert `true` → `Some`.
  5. `an_unrelated_user_key_does_not_reject`: pick `b` from `(0..).map(|i| format!("u{i}"))` with `key_slot(&b) != key_slot("u")`; stamp → `invalidate_user_key(&b)` → insert under `"u"` is `true`.
  6. `a_tag_named_like_the_user_key_does_not_reject`: stamp → `invalidate_tags(["u"])` → an untagged insert with `Some("u")` is `true` (the arrays are separate).
  7. `clear_after_the_stamp_keeps_the_insert_out`.
  8. `a_rejected_insert_leaves_the_newer_entry`:
     - `s1; invalidate_user_key("u"); s2;`
     - insert `"new"`@`s2` → `true`; insert `"old"`@`s1` → `false`
     - the value is `"new"`, `key_index_size == 1`.
  9. (R2 uniform) `a_content_keyed_insert_is_checked_against_its_tags`:
     - stamp → `invalidate_tags(["t"])` → `insert(k("hash1"), …, &["t".into()], None, s)` is `false`;
     - `insert(k("hash2"), …, &[], None, s)` is `true`.
     - If R2 = skip, assert `true` for both instead.
- [ ] In `job_cache.rs`, add `renders_racing_a_user_key_invalidation_never_land_stale_phased`, following F86's phased test in `l1.rs`:
  - 8 threads × 200 rounds, `Barrier::new(9)` × 3, keys `k:c{i}/j0/u` with user key `"u"`;
  - the main thread per round runs `db.fetch_add(1); invalidate_user_key("u")` between `read` and `mutated`;
  - every insert returns `false` and every key is `None` after each round.
  - Add a `by_tags` variant of the same loop (tags `["t"]`, `invalidate_tags`).
- [ ] In `tests/cache.rs`, add `a_job_invalidated_during_its_call_is_recomputed_by_the_next_page`. Add `use brust_server::start;` and a local `boot_unbound(f, dir)`: `start(config(dir))` + `register_worker(Box::new(FakeBunHandle(f)))`, no `bind`.
  - Loop over `(planned, by_key)` in `[(true,true),(false,true),(true,false),(false,false)]`.
  - `temp_dist` sets `m["components"]["moveCard_d4"]["jobs"][0]["cache"]["key"] = json!("move.name")`.
  - The fake: `FakeBun::new(default_loader, jobs)`. `jobs` counts batches `b`. On `b == 1` it calls `srv2.get().unwrap().invalidate(…)` with `key: Some("tackle")` if `by_key`, else `tags: ["moves"]`. Then it answers `default_job(c)` for each call, with moveCard's `_s1` replaced by `format!("MOVE {name} b{b}")`.
  - Boot with `boot_in` (planned) or `boot_unbound`, then `srv.set`. Advance the clock through L1 only with 3 × `s.invalidate(InvalidateArgs { path: Some("/nowhere".into()), ..Default::default() })`: a job cache on its own clock would then pass the race, so this proves the wiring.
  - Assertions:
    - `GET /pokemon/pikachu` contains `tackle: MOVE tackle b1`.
    - `GET /pokemon/raichu` contains `tackle: MOVE tackle b2`. `f.counts().1 == 2`, and `f.last_jobs()` has a call whose `inputs.move.name == "tackle"`.
    - `GET /pokemon/mew` contains `tackle: MOVE tackle b2` and `f.counts().1 == 2`: the recomputed value cached.
    - (R5) A 4th `GET /pokemon/pikachu` is `MISS` and contains `b2` (without R5 it is a `HIT` with `b1`).
    - Do not assert on `growl` in the by-key case: its slot may collide with `tackle` (1/256).
- [ ] Run `cargo test -p brust-server --lib cache::job_cache && cargo test -p brust-server --test cache a_job_invalidated`. Expected:
  - tests 1, 2, 7, 8, 9 (uniform), the phased tests and the HTTP test FAIL (the HTTP test: the raichu page shows `b1` and `counts().1 == 1`);
  - 3-6 pass.
- [ ] Commit `test(server): read → invalidate({key}) → job insert must not land (F89, red)`.

### Task 4: Implement (`job_cache.rs`, `pipeline.rs`)
- [ ] Add `fn invalidated_since(&self, tags: &[String], user_key: Option<&str>, since: ReadStamp) -> bool`: true iff `cleared_at`, `key_inval[slot(u)]` (when `Some(u)`) or any `tag_inval[slot(t.as_str())]` has a SeqCst load `> since.0`.
- [ ] `insert`: after `_gate` (`:266`) and `_stripe` (`:273`), before `next_generation` (`:274`): `if self.invalidated_since(tags, user_key, since) { return false; }`. Nothing is indexed or written on rejection. Build the `Arc<[String]>` from `user_key` after the check.
- [ ] `invalidate_indexed` gains a `slots: &[AtomicU64]` parameter. Inside `gate.write()`, before `take_tagged`: `let seq = self.clock.next(); for n in names { slots[self.slot(n.as_str())].fetch_max(seq, Ordering::SeqCst); }`. `invalidate_tags` passes `&self.tag_inval` and `invalidate_user_key` passes `&self.key_inval`.
- [ ] `clear`, inside `gate.write()`: `self.cleared_at.fetch_max(self.clock.next(), Ordering::SeqCst);`.
- [ ] `apply_job_results` returns `Result<bool, Response<ResponseBody>>` (`true` = an insert was rejected; R5). Log each rejection as in R3. Both call sites: `Ok(true) => cacheable = false`. If R5 is not accepted, keep `Result<(), _>` and only log.
- [ ] Run `cargo test -p brust-server --lib cache:: && cargo test -p brust-server --test cache`. Expected: all pass. Run the phased tests 20×: `for i in $(seq 20); do cargo test -p brust-server --lib cache::job_cache::tests::renders_racing -q || break; done`. Then `git stash` the fix once and confirm the phased tests fail.
- [ ] Commit `fix(server): a job-cache insert stamped before a covering invalidation does not land (F89)`.

### Task 5: Docs, ledger, hot path, READY
- [ ] Add a "Read stamps (F89)" paragraph to the `job_cache.rs` module doc, and extend the struct invariant (`:144-150`) with:
  > An insert lands only if no covering invalidation took a clock sequence after its `ReadStamp`. Covering means `invalidate_user_key` of its user key (by slot), `invalidate_tags` of one of its tags (by slot), or `clear`; `invalidate_key` does not publish (no production caller). The clock is shared with L1 (`Server::clock`), and `page()` stamps once for both. Each covering invalidation publishes under the exclusive gate, and an insert checks under the shared gate + its stripe and holds both until its write. A slot collision only skips caching one value. Lock order unchanged: gate → stripe → index / front.
- [ ] Add a sentence to the `config.rs:289-293` doc: a job value computed by a call that began before the invalidation is not cached, and its page is not stored in L1 (R5).
- [ ] Ledger: in the F89 row, replace the fix cell with `DONE 2026-10-xx — <commits>; shared InvalClock (stamp.rs), JobCache tag/user-key slots + cleared_at, insert -> bool, stamp threaded through apply_job_results (planned + unplanned); tests: job_cache read-stamp ×9 + phased ×2, tests/cache.rs a_job_invalidated_during_its_call_is_recomputed_by_the_next_page`.
- [ ] Hot-path proof (each prints its tag):
  - `sed -n '/pub fn get(&self, k: &JobKey)/,/^    }$/p' crates/brust-server/src/cache/job_cache.rs | diff /tmp/f89-jobget.before - && echo JOB-GET-UNCHANGED`
  - `sed -n '/pub(crate) fn lookup_jobs/,/^}$/p' crates/brust-server/src/pipeline.rs | diff /tmp/f89-lookup.before - && echo LOOKUP-UNCHANGED`
  - `sed -n '/pub fn get_with/,/^    }$/p' crates/brust-server/src/cache/l1.rs | diff /tmp/f89-getwith.before - && echo GET_WITH-UNCHANGED`
  - `sed -n 305,324p crates/brust-server/src/pipeline.rs | diff /tmp/f89-probe.before - && echo PROBE-UNCHANGED`
  - `git diff origin/beta1 --stat` lists only Boundary files.
- [ ] Run the Gates; commit `docs(server): job-cache read-stamp invariant; ledger F89 closed`; send the READY note.

## Acceptance (reviewer)
- [ ] `cargo test -p brust-server --lib cache::job_cache` → 16 old + 11 new pass; `renders_racing` passes 20× in a loop.
- [ ] `cargo test -p brust-server --test cache a_job_invalidated` → ok. With only that test cherry-picked onto `origin/beta1` (it uses no new API), it fails: the raichu page shows `b1`.
- [ ] `JOB-GET-UNCHANGED`, `LOOKUP-UNCHANGED`, `GET_WITH-UNCHANGED` and `PROBE-UNCHANGED` all print.
- [ ] `grep -n -A8 'pub fn insert' crates/brust-server/src/cache/job_cache.rs` → one `insert`, with `since: ReadStamp,` and `) -> bool {`. `grep -rn "inval_seq" crates/brust-server/src` → only doc text, if any.
- [ ] `cargo test -p brust-server --lib cache::l1` → the same count as Task 1 (F86 tests unchanged). `cargo test -p brust-server --test l1_concurrency --test l1_front` → ok.
- [ ] `cargo test -p brust-server --release --test single_roundtrip -- --nocapture` → ok, including `eight_workers_plan_while_tokio_inserts_and_invalidates`. Under R2 uniform it may show more two-call pages; its assertions are bounds.
- [ ] `cargo test -p brust-server --test review_fixes --test plan_offer --test store --test store_job_keys --test server` → ok.

## Gates
- `cargo fmt --all -- --check`
- `cargo clippy -p brust-compiler -p brust-compiler-cli -p brust-jinja -p brust-server -p brust-napi --no-deps -- -D warnings`
- `cargo test --workspace --exclude bun_react_compiler`
- `cargo test -p brust-server --release --test single_roundtrip -- --nocapture`
- `cargo bench -p brust-server --bench render --no-run`
- `cd packages/brust && bun run build:debug && bun run build && bun run typecheck && bun test`
- `bun test --timeout 120000 tests/server/pokedex.test.ts`
- `bun test --timeout 120000 tests/server/hydrate.chromium.test.ts`
- `bun run m2-exit` (report diff empty)
- `bun test bench/lib && (cd bench/apps/brust && bun test)`

Run each server-starting file alone if a combined run flakes on a port.

## Risk ledger
- **Clock wiring.** If `server/mod.rs` builds the caches on separate clocks, the stamp is meaningless for one of them. *Breaks visibly:* the HTTP test pre-advances the clock through L1, so it fails.
- **Memory ordering.** SeqCst for the stamp load, `next`, `fetch_max` and the insert-side loads, as in F86. *Breaks visibly:* the phased tests fail intermittently in `--release`.
- **Deadlock.** Publish only inside `gate.write()`, before `take_tagged`. Never hold an index or front lock across a moka call: the listener takes both. *Breaks visibly:* `invalidate_between_index_and_insert_is_not_lost` or `concurrent_reinserts_leave_front_and_moka_agreeing` hangs (zsh has no `timeout`; > 60 s is a hang).
- **False rejections.** A slot collision (1/256 per name pair) or a racing invalidation means more misses and more `jobs` round trips under heavy invalidation, and it keeps the plan offer on (P7). *Watch:* `RUST_LOG=brust::cache=debug` count of "job cache insert skipped". Tests pick names via `tag_slot`/`key_slot` or they flake 1/256.
- **R5 changes L1 behaviour.** A page that raced an invalidation is not cached, so L1 hit rate drops only under that race.
- **Residual (not fixed):** pages L1 cached before `invalidate({key})`, and hits pinned at plan time (`hits_pinned_at_plan_time_survive_an_invalidation_before_render`), still render pre-invalidation values. Both are the documented limit.
- **F86 regression.** `l1.rs` changes are mechanical. Its 41 tests plus `tests/l1_concurrency.rs` must stay green unchanged.

## Reporting
`conclave task note 838f12fb-70c1-41b7-acf2-d4065cf6bb64 beta1-f89-job-cache-generation READY @<sha> …`. The note must contain:
- the commit list;
- R1-R6 as implemented;
- the new test names with pass counts and the 20× loop result;
- the "phased test fails without the fix" confirmation;
- the four `*-UNCHANGED` lines and the hot-path argument: a HIT returns before the stamp, and a job HIT never reaches `insert`;
- each gate with its result;
- the F89 ledger cell as written.

Escalate via `conclave task challenge 838f12fb-70c1-41b7-acf2-d4065cf6bb64 beta1-f89-job-cache-generation "<what, evidence>"` for any of these:
- F86 is not on `beta1` or row F89 is missing;
- a change outside the Boundary;
- an existing assertion that must change;
- a concurrency test that cannot be made deterministic;
- any HIT-path diff.
