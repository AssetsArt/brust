# beta1-f86-l1-generation: L1 read stamps — a render that began before an invalidation never lands in L1
**RULED by lead Detoro 2026-10-12 (before dispatch): R1 ACCEPTED (256 hashed per-tag slots + `inval_seq`; a false rejection costs one uncached render). R2 ACCEPTED (both `invalidate_path` and `clear` participate; `invalidate_path` stays gate-free, publish-then-scan under the shard stripe). R3 ACCEPTED (`insert -> bool`, debug log at the call site, no stats field). R4 ACCEPTED as follow-up: the lead files ledger row F89 (job cache `cache({key})` entries) at merge with the row text from the READY note, and the SAME implementer takes it as lane `beta1-f89-job-cache-generation` right after this lane is READY (plan to follow, reusing `ReadStamp`). R5 ACCEPTED (`ReadStamp`, new last parameter, no unstamped `insert`). R6 RULED: THIS lane owns the `l1.rs` doc comments (invariant + gate-free rationale); lane `beta1-f81-l1-concurrency` is reduced to committing its two tests and touches no `l1.rs` line. Because F81 is routine and may merge into `beta1` first, Task 2 of this lane also updates `crates/brust-server/tests/l1_concurrency.rs` (if present on `beta1` when you rebase) to pass `read_stamp()`; that file is added to the Boundary. The lead files the F86 ledger cell at merge.**
owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · base: beta1 · lane: beta1-f86-l1-generation · tier: complex · review: complex
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Ledger row F86 (`docs/plans/m1a-followups.md:150`), quoted: "L1 insert takes its generation at insert time, so a render that read the team roster BEFORE a `POST /team` can be inserted AFTER the mutation's `invalidate({tags:['team']})` and serve a stale team page for its TTL (up to 3600 s on `/type-chart`). Fix: stamp the generation at render START (read-side generation captured when the loader context is taken) and reject an insert whose generation is older than the last invalidation of any of its tags; test: read → invalidate → insert must not land."

## Facts the plan rests on (v2 @ 79885d3 = beta1; re-anchor on the quoted text if lines moved)

- **The only L1 insert** is `crates/brust-server/src/pipeline.rs:597-604` at the end of `page()` (`:285`): `s.l1.insert(k, body, Duration::from_secs(c.ttl_seconds), &c.tags);`. Its tags are `route.cache.tags`, fixed in the manifest (`manifest.rs:34-42` `RouteCache`). Pokedex: `/pokemon/{name}` `ttl_seconds: 60, tags: ['pokemon','team']` and `/type-chart` `ttl_seconds: 3600, tags: ['types','team']` (`examples/pokedex/routes.tsx:20-21`); `POST /team` calls `invalidate({ tags: ['team'] })` (`examples/pokedex/actions.ts:18`).
- **Order inside `page()`:** `l1_decision` `:306` → HIT probe `s.l1.get_with` `:308-324` (a HIT returns at `:320-323`) → envelope `:326` → first worker call `call_worker_planned(… CallKind::Loader …)` `:370` (the loader reads app data here; a planned call also runs jobs here) → unplanned jobs call `:518` → `render_document` `:570` → `store` `:576` → insert `:597-604`. A BYPASS (`l1_decision` returns `(None, Bypass, _)` at `:1048`, `:1089`, `:1119`) and an uncached route (`:1036`) have `cache_key == None` and never insert.
- **Invalidation path:** worker JS `cache.invalidate(args)` (`packages/brust/src/cache.ts:11-23`) → napi `cache_invalidate` (`crates/brust-napi/src/server.rs:283-297`, synchronous on the worker's JS thread) → `Server::invalidate` (`crates/brust-server/src/config.rs:294-308`): `tags` → `l1.invalidate_tags` + `jobs.invalidate_tags`; `path` → `l1.invalidate_path(method or "GET", path)`; `key` → `jobs.invalidate_user_key` only. `L1Cache::clear` has no production caller (tests only).
- **`l1.rs` today:** `insert` `:392-438` takes `gate.read()` `:403`, the key's stripe `:406-407`, stamps `next_generation.fetch_add` `:408` (this generation guards the tag index/front against moka's Replaced listener; it says nothing about read time), indexes `:409`, test hook `mid_insert` `:410-413`, front write `:418-429`, moka insert `:430-437`. `invalidate_tags` `:491-503` holds `gate.write()` across `take_tagged` + `remove`. `invalidate_path` `:467-483` is gate-free: scans every front shard, then `remove(k)` (stripe `:443`). `clear` `:508-525` holds `gate.write()`. Struct doc + invariant `:251-265`; struct `:266-292`; `stripes[i]` guards keys of `front[i]` (both indexed by `shard_of`, `:136-138`, `:406-407`).
- **Job cache** (`crates/brust-server/src/cache/job_cache.rs`): same shape, inserted only at `pipeline.rs:665-671` (`apply_job_results`). Keys come from `plan_key` (`pipeline.rs:1515-1532`): no `cache({key})` → `inputs::job_key(cid, job, projected)`, a hash of the job's inputs; with `cache({key})` → `"k:<cid>/<job>/<user key>"`.
- **Other `L1Cache::insert` callers:** `crates/brust-server/benches/render.rs:254` (bench; CI does not build benches) and 20 calls + the `ins` helper (`:902-905`) in `l1.rs` tests.
- **Bench bar** (`bench/RESULTS.md`/`RESULTS.json`, 2026-10-11): S `/types` = L1 HIT path, 113,744 rps; D `/dex?nocache=1` and I `/team?nocache=1` = BYPASS (cache_key `None`).

## Goal

- An L1 insert carries a **read stamp** taken in `page()` after the HIT probe missed and before the envelope/first worker call. The insert does not land if a covering invalidation took a sequence number after that stamp: a tag invalidation of one of its tags, `invalidate_path` of its method+path, or `clear` (R2).
- read → `invalidate({tags})` → insert: no entry, and the next request is a MISS that renders fresh data. Covered by an `l1.rs` unit test and by an HTTP test whose loader invalidates mid-call.
- read → insert → invalidate still evicts. invalidate → read → insert lands. A rejected insert leaves any newer entry alone. An untagged insert ignores tag invalidations.
- Many renders racing invalidations never leave a stale entry. Two concurrency tests per kind (tags, path) prove it: one barrier-phased (deterministic), one free-running with an end-state check.
- The HIT path (`get_with`, `pipeline.rs:308-324`) and the BYPASS path are byte-for-byte unchanged. A MISS adds one atomic load plus, at insert, at most `tags + 2` atomic loads and hashes.
- The `l1.rs` invariant comment documents the new rule and why `invalidate_path` stays gate-free (R6).

## Rulings requested

**R1: how "last invalidation per tag" is represented.** *Recommended:* add a dedicated monotonic counter `inval_seq: AtomicU64`. A read stamp is its SeqCst load. Each invalidation takes `fetch_add(1)+1` and `fetch_max`es that value into a fixed array of 256 `AtomicU64` slots indexed by `hasher.hash_one(tag) % 256`. An insert is rejected iff any of its tags' slots is greater than its stamp. Memory is 2 KiB, constant. The array is lock-free and cold: only invalidations write it and only MISS inserts read it. A false rejection needs an unrelated tag to share a slot while a render is in flight (probability about k/256 per concurrent invalidation, for a route with k tags), and it costs one uncached render; the next MISS caches. *Alternatives:*
- (a) An exact `HashMap<String,u64>` beside the tag index. It has no false rejections, but it grows with every distinct tag ever invalidated, and those names are app-controlled (`invalidate({tags:[`user:${id}`]})`). Pruning it safely needs the oldest in-flight stamp, which means a registry on the MISS path. Rejected.
- (b) One global epoch. Memory is O(1), but every invalidation of ANY tag rejects every in-flight insert of every route. At 50 invalidations/s and a 20 ms render, about 63% of all MISS renders would stay uncached.
- (c) An exact table of the manifest's L1 tags, built at boot. It is bounded and exact, but it changes `L1Cache::with_capacity` (`server/mod.rs:135`) and every test constructor.

**R2: do `invalidate_path` and `clear` participate?** *Recommended: both.*
- `invalidate_path` has the identical hole: `cache.invalidate({path})` is public. Its participation uses a second 256-slot array keyed by `(method, path)`, the same predicate `invalidate_path` matches (prefix and query are ignored). `invalidate_path` stays gate-free (F81's rationale): it publishes its seq first, then scans and removes shard `i` while holding `stripes[i]`. An insert holds its shard's stripe across check and write, so it either lands before that shard's scan (and is removed) or checks after the publish (and is rejected).
- `clear` sets `cleared_at = seq` under its exclusive gate. That is one atomic, and it keeps the semantics uniform even though there is no production caller.

*Alternative:* tags only, as the ledger words it, with path filed as a follow-up. That leaves `{path}` invalidation with the same stale-for-TTL bug.

**R3: is a rejected insert observable?** *Recommended:* `L1Cache::insert` returns `bool` (`false` = rejected). The call site logs `tracing::debug!(target: "brust::cache", route = %route.id, "L1 insert skipped: invalidated during the render")`. No stats field is added: `CacheStats` (`l1.rs:180-186`) is shared with the job cache and serialized as the `/_brust/cache/stats` contract. *Alternative:* a `rejected` counter in `CacheStats` (the job cache reports 0), plus docs.

**R4: does the job cache get the same treatment in this lane?** *Recommended: no; file F89.* Content-keyed job entries are immune: the key hashes the inputs (`pipeline.rs:1515-1532`), so changed data is a different key. Only `cache({key})` entries (`k:<cid>/<job>/<key>`) can hold a value computed before an `invalidate({key|tags})` under a stable key. The fix is the same mechanism on two indexes (tags, user keys) with the stamp threaded through `apply_job_results` (`pipeline.rs:614`) for both the planned and the unplanned job path. Doing it here doubles the review surface beyond "l1.rs + one call site". Proposed row: "F89 | `crates/brust-server/src/cache/job_cache.rs` insert + `pipeline.rs` `apply_job_results` | A `cache({key})` job value computed by a call that began before `invalidate({key})`/`({tags})` can be inserted after it and served (and baked into later L1 pages) until its ttl, which defaults to none. Content-keyed entries are immune. | Reuse F86's read stamp: tag + user-key slot arrays in `JobCache`, `insert(…, since) -> bool`, the stamp taken once in `page()` before the loader call; test read → invalidate({key}) → insert must not land. | beta follow-up (complex)". *Alternative:* include it as an extra task, with `job_cache.rs` added to the boundary.

**R5: how the stamp reaches the insert.** *Recommended:* an opaque `#[must_use] pub struct ReadStamp(u64)` (Copy, private field) from `pub fn read_stamp(&self) -> ReadStamp`. It is held as a local `since` in `page()` and passed as a new last parameter: `insert(key, body, ttl, tags, since: ReadStamp) -> bool`. No unstamped `insert` remains, so a future call site cannot forget the stamp. *Alternatives:*
- (a) A field on `PageMeta`. Nothing else reads it.
- (b) An RAII `begin_read()` guard registered in a shared structure. It is only needed to prune R1(a), and it adds shared writes to the MISS path.
- (c) Keep a 4-argument `insert` that stamps "now". This is a footgun: it silently reintroduces F86.

**R6: overlap with F81.** F81 (`m1a-followups.md:145`) commits two L1 concurrency probes and adds "invalidate_path is gate-free on purpose" to the invariant comment at `l1.rs:266`. *Recommended:* this lane writes that rationale, because it changes `invalidate_path` to stripe-scanned and rewrites the comment. F81 shrinks to committing the probes, rebased after this lane. *Alternative:* land F81 first and rebase this lane on it.

## Boundary

`crates/brust-server/src/cache/l1.rs` · `crates/brust-server/src/pipeline.rs` (only `page()`: the stamp after `:324` and the insert at `:597-604`) · `crates/brust-server/benches/render.rs` (the `:254` call) · `crates/brust-server/tests/cache.rs` (one new test) · `crates/brust-server/tests/l1_concurrency.rs` (R6: only the `insert` calls, if the file exists on `beta1`). Not touched: `config.rs`, napi, `packages/*`, `docs/plans/m1a-followups.md` (the lead files ledger rows), `tests/l1_front.rs`, `tests/single_roundtrip.rs`. Shared host: kill only PIDs you spawned.

## Tasks

### Task 1: Lane, baseline
- [ ] `cd ~/code/brust && git fetch origin && git worktree add ~/code/brust-lane-beta1-f86-l1-generation -b lane/beta1-f86-l1-generation beta1 && cd ~/code/brust-lane-beta1-f86-l1-generation && bun install --frozen-lockfile` (use `origin/beta1` if `beta1` is not local).
- [ ] `(cd packages/brust && bun run build:debug)`. Expected: exits 0.
- [ ] `cargo test -p brust-server --lib cache::l1`. Expected: `test result: ok. 19 passed`.
- [ ] `cargo test -p brust-server --test cache --test l1_front --test single_roundtrip`. Expected: all `ok`, `0 failed`.
- [ ] `cargo test -p brust-server --release --test single_roundtrip -- --nocapture`. Expected: `ok`.
- [ ] Save the HIT-path baselines:
  - `git show beta1:crates/brust-server/src/cache/l1.rs | sed -n '/pub fn get_with/,/^    }$/p' > /tmp/f86-getwith.before`
  - `sed -n 305,324p crates/brust-server/src/pipeline.rs > /tmp/f86-probe.before`

### Task 2: API shape, no behaviour (all callers compile, everything green)
Files: `l1.rs`, `pipeline.rs`, `benches/render.rs`.
- [ ] In `l1.rs` add `ReadStamp` (R5), `const INVAL_SLOTS: usize = 256;`, and fields on `L1Cache`, each initialised in `with_capacity` (`(0..INVAL_SLOTS).map(|_| AtomicU64::new(0)).collect()`):
  - `inval_seq: AtomicU64`
  - `tag_inval: Box<[AtomicU64]>`
  - `path_inval: Box<[AtomicU64]>`
  - `cleared_at: AtomicU64`
- [ ] Add `pub fn read_stamp(&self) -> ReadStamp { ReadStamp(self.inval_seq.load(Ordering::SeqCst)) }`.
- [ ] Change the signature to `pub fn insert(&self, key: CacheKey, body: Arc<RenderedBody>, ttl: Duration, tags: &[String], since: ReadStamp) -> bool`. It still always lands and returns `true`.
- [ ] Update the 20 test calls and `ins` to pass `c.read_stamp()` (in `invalidate_between_index_and_insert_is_not_lost` `:891-893`, take the stamp inside the spawned thread, before `insert`).
- [ ] Update `benches/render.rs:254` to pass `l1.read_stamp()`.
- [ ] `pipeline.rs`: right after the closing brace at `:324`, add the line below with a 3-line comment: the stamp is taken after the probe missed and before the first worker call, a HIT returned above, a BYPASS has no key. Then change `:597-604` to the shape below.
  ```rust
  let since = cache_key.as_ref().map(|_| s.l1.read_stamp());
  ```
  ```rust
  if store && let Some(k) = cache_key && let Some(c) = &route.cache && let Some(since) = since
      && !s.l1.insert(k, body, Duration::from_secs(c.ttl_seconds), &c.tags, since)
  {
      tracing::debug!(target: "brust::cache", route = %route.id, "L1 insert skipped: invalidated during the render");
  }
  ```
- [ ] Run `cargo test -p brust-server --lib cache::l1 && cargo bench -p brust-server --bench render --no-run`. Expected: 19 passed; bench builds.
- [ ] Commit `refactor(server): L1 insert takes a read stamp (F86, no behaviour change)`.

### Task 3: Red tests first (tags, clear, HTTP)
Files: `l1.rs` `mod tests`, `tests/cache.rs`.
- [ ] Add `#[cfg(test)] pub(crate) fn tag_slot(&self, t: &str) -> usize` and `path_slot(&self, m: &str, p: &str) -> usize`, using the same slot function the implementation will use: `(self.hasher.hash_one(v) as usize) % INVAL_SLOTS`, hashing `t: &str` and `(m, p): (&str, &str)`.
- [ ] Unit tests, all with ttl 60 s:
  1. `an_invalidation_after_the_read_stamp_keeps_the_insert_out`:
     - `let s = c.read_stamp(); c.invalidate_tags(&["t".into()]);`
     - `assert!(!c.insert(k, rb_of("old"), ttl, &["t".into()], s));`
     - `html(&c,&k)` is `None`; after `run_pending`, `(front_len, tag_index_size, stats().len) == (0,0,0)`.
  2. `an_insert_before_the_invalidation_is_still_evicted`: stamp → insert (`true`) → `invalidate_tags` returns 1 → `None`.
  3. `a_stamp_after_the_invalidation_lands`: invalidate → stamp → insert `true` → `Some("new")`.
  4. `an_untagged_insert_ignores_tag_invalidation`: stamp → `invalidate_tags(["t"])` → insert with `&[]` is `true`.
  5. `an_unrelated_tag_invalidation_does_not_reject`: pick `b` from `(0..).map(|i| format!("u{i}"))` with `tag_slot(&b) != tag_slot("t")`; stamp → `invalidate_tags([b])` → insert tagged `t` is `true`.
  6. `clear_after_the_stamp_keeps_the_insert_out`: stamp → `clear()` → insert `false`.
  7. `a_rejected_insert_leaves_the_newer_entry`:
     - `s1 = stamp; invalidate_tags(t); s2 = stamp;`
     - `insert(k,"new",s2)` → `true`; `insert(k,"old",s1)` → `false`
     - `html == "new"`, `tag_index_size == 1`.
- [ ] HTTP test `an_invalidation_during_the_loader_keeps_that_render_out_of_l1` in `tests/cache.rs` (add `use brust_server::Server; use std::sync::OnceLock;`):
  - Build the fake: `let srv: Arc<OnceLock<Arc<Server>>> = Default::default();` and a `FakeBun::new` loader that counts calls like `counting_fake` (`:17-26`). On call 1 it runs `srv2.get().unwrap().invalidate(InvalidateArgs { tags: vec!["sized".into()], ..Default::default() })` before replying `{"ok":true,"data":{"who":"v1"}}`.
  - Boot: `boot_in(f.clone(), sized_dist(PAD).path())`, then `srv.set(Arc::clone(&s))`.
  - Three identity `GET /sized` requests answer `MISS`/`v1`, `MISS`/`v2`, `HIT`/`v2`. Assert `<h1>v2</h1>` in bodies 2 and 3.
  - `f.counts().0 == 2` and `stats(&s)["l1"]["len"] == 1`.
- [ ] Run `cargo test -p brust-server --lib cache::l1 && cargo test -p brust-server --test cache`. Expected: tests 1, 6, 7 and the HTTP test FAIL (the HTTP test: the 2nd response is `HIT` with `v1`); 2-5 pass. Commit `test(server): read → invalidate → insert must not land in L1 (F86, red)`.

### Task 4: Implement tags + clear
File: `l1.rs`.
- [ ] Add these helpers:
  - `fn next_inval(&self) -> u64 { self.inval_seq.fetch_add(1, Ordering::SeqCst) + 1 }`
  - `fn slot<T: std::hash::Hash + ?Sized>(&self, v: &T) -> usize`
  - `fn invalidated_since(&self, key: &CacheKey, tags: &[String], since: ReadStamp) -> bool`: true iff any of `cleared_at`, `path_inval[slot(&(key.method.as_str(), key.path.as_str()))]` or `tag_inval[slot(t.as_str())]` for a tag `t` has a SeqCst load greater than `since.0`.
- [ ] `insert`: after taking the gate (`:403`) and the stripe (`:407`), before `next_generation` (`:408`): `if self.invalidated_since(&key, tags, since) { return false; }`. Nothing is indexed or written on rejection.
- [ ] `invalidate_tags`: inside `gate.write()`, before `take_tagged`: `let seq = self.next_inval(); for t in tags { self.tag_inval[self.slot(t.as_str())].fetch_max(seq, Ordering::SeqCst); }`. `clear`: inside `gate.write()`: `self.cleared_at.fetch_max(self.next_inval(), Ordering::SeqCst);`.
- [ ] Run `cargo test -p brust-server --lib cache::l1 && cargo test -p brust-server --test cache`. Expected: all pass (26 lib tests). Commit `fix(server): an L1 insert stamped before a covering invalidation does not land (F86)`.

### Task 5: `invalidate_path` participates (R2)
- [ ] Red tests first:
  - `invalidate_path_after_the_stamp_keeps_the_insert_out`: key `GET /p x=1`; stamp → `invalidate_path("GET","/p")` → insert `false`.
  - `invalidate_path_of_another_path_does_not_reject`: pick `/q{i}` with `path_slot("GET",q) != path_slot("GET","/p")`; insert `true`.
  - Expected: the first fails.
- [ ] Rewrite `invalidate_path` (`:467-483`):
  1. `let seq = self.next_inval(); self.path_inval[self.slot(&(method, path))].fetch_max(seq, SeqCst);`
  2. For each `(shard, s)` in `self.front.iter().enumerate()`: take `self.stripes[shard].lock()`. Collect the matching keys and count the live ones in a block that drops the read guard. Then for each key run `self.inner.remove(k); s.write().remove(k);`. Never hold a front guard across a moka call: the listener takes that shard's write lock.
  3. `run_pending_tasks`; return `live`. The return semantics are unchanged (live matches at call time).
- [ ] Run `cargo test -p brust-server --lib cache::l1 && cargo test -p brust-server --test l1_front`. Expected: all pass, including `invalidate_path_removes_only_matching_entries`, `eviction_listener_prunes_on_invalidate_path` and `invalidation_under_concurrent_hits_is_immediate`. Commit `fix(server): invalidate_path rejects renders stamped before it, still gate-free (F86)`.

### Task 6: Concurrency tests (`l1.rs` `mod tests`, deterministic)
- [ ] `renders_racing_a_tag_invalidation_never_land_stale_phased`:
  - Setup: 8 render threads, 200 rounds, `std::sync::Barrier::new(9)` × 3 (`read`, `mutated`, `inserted`), `db: AtomicU64`.
  - Render `i` per round: `since = stamp; v = db.load(SeqCst); read.wait(); mutated.wait(); insert(key /r{i}, v, ["t"], since); inserted.wait()`.
  - Main thread per round: `read.wait(); db.fetch_add(1); invalidate_tags(["t"]); mutated.wait(); inserted.wait();` then assert every `/r{i}` is `None` and every insert returned `false`.
- [ ] `renders_racing_tag_invalidations_end_fresh_free_running`:
  - 8 threads × 2000 renders on 16 keys: `since; v = db; yield_now(); insert(…, ["t"], since)`.
  - An invalidator thread does 500 × `{ db.fetch_add(1); invalidate_tags(["t"]); yield_now() }`.
  - After the join, run one final `db.fetch_add(1); invalidate_tags(["t"])` with no renders outstanding, then 16 fresh renders. Every present entry's body == the final `db` value.
  - Also assert `front_len() == stats().len` after `run_pending()` (front and moka agree after the churn).
- [ ] The same two tests for `invalidate_path("GET","/r")` with keys `GET /r x={i}`: `…_path_phased`, `…_path_free_running`.
- [ ] Run each new test 20×: `for i in $(seq 20); do cargo test -p brust-server --lib cache::l1::tests::renders_racing -q || break; done`. Expected: 20 green runs. Revert Task 4/5 locally (`git stash`) once and confirm the phased tests fail. Commit `test(server): renders racing invalidations never leave a stale L1 entry (F86)`.

### Task 7: Invariant docs, hot-path argument, gates, READY
- [ ] Module doc `:10-16`: add a paragraph "Read stamps (F86)". Struct doc `:251-265`: extend the invariant with:
  > An insert lands only if no covering invalidation took an `inval_seq` after its `ReadStamp`. A covering invalidation is a tag of the insert (by slot), its method+path (by slot), or `clear`. Tag invalidation and `clear` publish under the exclusive gate, and the insert checks under the shared gate. `invalidate_path` is gate-free on purpose: the front is a superset of moka and the key stripe orders same-key writers. It publishes before scanning and scans shard i under `stripes[i]`, which an insert holds across check and write. A slot collision or an already-seen invalidation only skips caching one render. Lock order unchanged: gate → stripe → (index | front).
- [ ] Hot-path proof:
  - `sed -n '/pub fn get_with/,/^    }$/p' crates/brust-server/src/cache/l1.rs | diff /tmp/f86-getwith.before - && echo GET_WITH-UNCHANGED`
  - `git diff beta1 -- crates/brust-server/src/pipeline.rs`: shows hunks only after the HIT `return` and at the insert.
  - Write the argument in the READY note: a HIT returns before the stamp; a BYPASS has `cache_key == None`, so the S/D/I probes run no new instruction.
- [ ] Run the Gates below; commit `docs(server): L1 read-stamp invariant (F86)`; send the READY note.

## Acceptance (reviewer)
- [ ] `cargo test -p brust-server --lib cache::l1` → 19 old + 13 new tests pass; the 4 concurrency tests pass 20× in a loop.
- [ ] `cargo test -p brust-server --test cache an_invalidation_during_the_loader` → ok; on `beta1` (test cherry-picked onto the base) it fails with the 2nd response `HIT`.
- [ ] `GET_WITH-UNCHANGED` printed; `git diff beta1 --stat` touches only Boundary files.
- [ ] `cargo test -p brust-server --release --test single_roundtrip -- --nocapture` → ok. `hits_pinned_at_plan_time_survive_an_invalidation_before_render` asserts loader/job counts only, so a rejected raichu insert does not change them.
- [ ] `cargo test -p brust-server --test l1_front --test review_fixes --test plan_offer --test store` → ok.
- [ ] `grep -n "Read stamps\|ReadStamp" crates/brust-server/src/cache/l1.rs` shows the module doc, the struct invariant and the type.
- [ ] No unstamped insert: `grep -n "fn insert" crates/brust-server/src/cache/l1.rs` shows one signature, ending `since: ReadStamp) -> bool`.

## Gates
`cargo fmt --all -- --check` · `cargo clippy -p brust-compiler -p brust-compiler-cli -p brust-jinja -p brust-server -p brust-napi --no-deps -- -D warnings` · `cargo test --workspace --exclude bun_react_compiler` · `cargo test -p brust-server --release --test single_roundtrip -- --nocapture` · `cargo bench -p brust-server --bench render --no-run` (new: the bench calls `insert`) · `cd packages/brust && bun run build:debug && bun run build && bun run typecheck && bun test` · `bun test --timeout 120000 tests/server/pokedex.test.ts` · `bun test --timeout 120000 tests/server/hydrate.chromium.test.ts` · `bun run m2-exit` (report diff empty) · `bun test bench/lib && (cd bench/apps/brust && bun test)`. Run each server-starting file alone if a combined run flakes on a port.

## Risk ledger
- **Memory ordering.** If `inval_seq` or a slot uses Relaxed, a render can stamp below an invalidation it observed through the data. Use SeqCst for the stamp load, the `fetch_add`, `fetch_max` and the insert-side loads. *Breaks visibly:* the free-running tests fail intermittently in `--release`.
- **`invalidate_path` deadlock.** Holding a front read/write guard across `self.inner.remove` deadlocks: moka may run the listener inline, and it takes `front[shard].write()`. *Breaks visibly:* `l1_front` / Task 6 path tests hang. zsh has no `timeout`, so watch elapsed time; a test > 60 s is a hang.
- **Lock order.** Gate → stripe → (index | front). `invalidate_path` takes stripe → front only, never the gate. A stripe taken under a front guard inverts the order. *Breaks visibly:* hangs in `concurrent_reinserts_leave_front_and_moka_agreeing`.
- **False rejections.** Slot collisions (1/256 per tag pair; `RandomState` reseeds per process) and invalidations racing renders that already saw fresh data mean fewer cached renders under heavy invalidation. *Watch:* `RUST_LOG=brust::cache=debug` count of "L1 insert skipped". Tests must pick non-colliding names via `tag_slot`/`path_slot` or they flake 1/256.
- **Seq overflow.** u64 at 1e9 invalidations/s is centuries. No handling.
- **F81 merge conflict** on the `l1.rs` invariant comment (R6).
- **Job cache (R4)** stays exposed for `cache({key})` entries until F89. An L1 MISS that reads such a stale job value caches a stale page that this lane's fix cannot catch.

## Reporting
`conclave task note 838f12fb-70c1-41b7-acf2-d4065cf6bb64 beta1-f86-l1-generation READY @<sha> …`. The note must contain:
- the commit list;
- the R1-R6 rulings as implemented;
- the new test names with pass counts (and the 20× loop result);
- the "phased test fails without the fix" confirmation;
- `GET_WITH-UNCHANGED` and the hot-path argument;
- each gate with its result;
- if R4 = follow-up, the proposed F89 row text verbatim for the lead to file.

Escalate via `conclave task challenge 838f12fb-70c1-41b7-acf2-d4065cf6bb64 beta1-f86-l1-generation "<what, evidence>"` for any of these:
- a needed change outside the Boundary;
- an existing test whose assertion must change;
- a concurrency test that cannot be made deterministic;
- any HIT-path diff.
