# m3f-store-server — the server half of the unified store: per-request worker scope, `LoaderResponse.store`, ctx `__store`, ssr `__store` input, `data-brust-store` tags, one runtime instance per page

**RULED by lead Detoro 2026-10-11 (before dispatch): R1 ACCEPTED (absent, never null; spec C1/C5 amended). R2 ACCEPTED (jobs.js `stores` table, emitted only when non-empty; spec C3 amended). R3 ACCEPTED (notFound carries store). R4 ACCEPTED (no runtime tag → no store tags). R5 ACCEPTED (0.1.x strings verbatim; already in spec §4). R6 ACCEPTED (explicit cache({key}) keeps the user key; documented in spec C5). CORRECTION to Task S5/S8: the core hook is exported from `@brust/runtime-dom/store/internal` (not `/store`): `__setServerResolver(fn: ServerResolver | null)`, `hydrateRecord`, types `StoreInstanceRecord`, `ServerResolver` — see docs/plans/2026-10-11-m3f-store-core.md Task 3/6; the worker-sees-ONE-core test compares `@brust/core/store` with `@brust/runtime-dom/store` as written. Also add `@brust/runtime-dom` and `@brust/runtime-dom/*` to JOBS_EXTERNALS (core plan risk 3). S9 perf STOP rule (>1% drop on D/I/S, interleaved) stands; report, do not tune.**
owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · base: m3f (worktree ~/code/brust-m3f) · lane: m3f-store-server · tier: complex · review: complex

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement spec §2.2 of `docs/design/2026-10-11-m3f-unified-store-design.md` (D4, D5, D6, D8, D3 build side; contracts C1, C2, C3 consumer, C4, C5, C6, C7). After this lane:
- the Bun worker runs every loader chain inside a per-request store scope (`AsyncLocalStorage`), touches the stores the route's components read (manifest `components[id].stores`, union over the route), and answers `{ ok, data, store }`;
- the Rust pipeline puts the snapshot at the reserved ctx key `__store` on BOTH the declined and the planned (P6) path, so templates read `__store.<name>.<key>`;
- every ssr job's inputs carry `__store` (so the job key covers it), and the worker renders each ssr job inside a store scope seeded from it;
- `render.rs` writes one `<script type="application/json" data-brust-store="NAME">` per store immediately before the runtime tag;
- island and native client builds resolve the store core to the runtime URL (one instance per page), and the `@brust/brust` server-only regex is fixed to `@brust/core`.

A page that touches no store renders byte-identical HTML and sends a byte-identical loader response.

**Architecture:** Rust: `protocol.rs` (one field on two variants), `pipeline.rs` (one reserved key, one merge helper used by the three loader-data sites, one insertion in `plan_one`), `render.rs` (one new injection fn; the old signature delegates). TS: `store/server-context.ts` (no core import, testable alone), `store/core-adapter.ts` (the ONLY file that names the core lane's API), `worker.ts` (scope + touch + ssr seed), `build/bundle.ts` (alias plugin + regex + jobs `stores` table), `build/index.ts` (order). No napi change: the loader response crosses as JSON in the SAB slot, never as a napi object.

**Tech Stack:** Rust nightly-2026-09-15, serde_json 1, minijinja 3.0.0, Bun canary (`node:async_hooks` `AsyncLocalStorage`, `Bun.build` plugins), TS 7 via `bun check`.

**Spec:** design D3–D8, C1–C7, §4 (errors), §5 items 1 and 3 (server half), §6 rows `server-context`, `serialize` (tag shape), `inject`. Global lane rules: design §7 last paragraph.

## Facts the plan rests on (m3f @ 3342353)

- **F1 — no napi object crossing.** The loader response is JSON written by `worker.ts:72-82` (`writeSlot`) and parsed by `protocol.rs:58-146` (custom visitor). `crates/brust-napi/src` never names `LoaderResponse`/`Verdict` (grep empty). The camelCase-object trap (memory `napi-object-camelcase-keys`) does not apply; the wire key `store` is one lowercase word in both directions. `planJobs` (`brust-napi/src/server.rs:185`) passes `(slot, len)` only.
- **F2 — Node maps are sorted.** `brust-jinja/src/ctx.rs:17` `MapInner = BTreeMap<Arc<str>, Node>`. Iterating `__store` yields names in byte order (C4's "sorted by name" for free). Inserting `__store` into a job's `inputs` map lands it in sorted position, which keeps `inputs::job_key` (`inputs.rs:243-264`, serde_json over the Node) deterministic.
- **F3 — L1 stores the rendered body, not the ctx.** `pipeline.rs:545-586`: `render_document` output → `RenderedBody` → `s.l1.insert`. The tag is inside the cached HTML, so a HIT serves it byte-identically (D5's "cached in L1 with the rest of the context" holds by construction). NOTE: `page()` already has a local `let store = …` (a bool, :558). Name the snapshot variable `snapshot`.
- **F4 — `_props` and `"*"` share one hide-list.** `props_view` (:869-874) and `all_props` (:1403-1414) both filter `PROPS_HIDDEN` (:877). Adding `__store` there keeps it out of every island's `x-props` (`teamBuilder_h8.jinja` prints `{{ _props | json_attr }}`) and out of precompute `"*"` inputs (D8). `plan_one` then adds it back for ssr jobs only.
- **F5 — both loader-data merge sites.** The declined path merges at `:384-396` (Ok) and `:401-405` (NotFound). The planned path merges inside `plan_response` (:1721-1760, run by `plan_in_call` :1765 on the worker's JS thread), and `page()` takes `pc.ctx` as-is at :461-480. A field that is only handled in `page()` is lost on every route with jobs.
- **F6 — SSR runs the worker's own `@brust/core`.** `bundle.ts:281` `JOBS_EXTERNALS` keeps `@brust/core` and `@brust/core/*` external. `@brust/core/store` in `jobs.js` is therefore the same module as the worker's import, so the resolver registered at worker boot is the one SSR sees. A bare `@brust/runtime-dom/store` import inside `jobs.js` would be bundled (a second, unregistered copy). Task S6 aliases it.
- **F7 — today islands would get a second core.** `buildReactChunks` (`bundle.ts:260-276`) has no `/_brust/*` external and no alias. `buildClientChunks` (:217-233) keeps `/_brust/*` external, but a `@brust/core/store` import in a store module would be bundled into the shared chunk. D3/C6 need both builds aliased.
- **F8 — the server-only regex names the wrong package.** `bundle.ts:103` `/^@brust\/brust\/(server|native)(\/|$)/`. The package is `@brust/core` (`packages/brust/package.json:2`, exports `./server`, `./native`). `@brust/core/server` → `src/server.ts` is neither builtin nor `*.server.*`, so it passes into browser bundles today.
- **F9 — Rust ignores `stores`.** `manifest.rs:56-69` `ComponentRecord` has no `deny_unknown_fields`. The compiler lane's `components[id].stores` needs no Rust change; the server never reads it.
- **F10 — the worker has no app root.** `run.ts:60-63` passes only `BRUST_DIST_DIR`/`BRUST_APP_ENTRY`; `dist/index.js` (`build/index.ts:160-172`) likewise. A project-relative store path (C3) cannot be resolved at runtime. The build can resolve it: it knows `appRoot` (`build/index.ts:79`). Hence R2.
- **F11 — CI runs named TS test files.** `.github/workflows/ci.yml:120-124` lists files explicitly. A new test file not added there never runs in CI.

## Rulings requested from the lead before dispatch

Each has a default that the implementer follows unless the lead answers differently.

- **R1 — absent, not `null` (C2/C5 wire reading).** The worker omits `store` from the loader JSON when `collectSnapshot()` is `null`. The pipeline omits ctx `__store` when the snapshot is absent, `null` or `{}`. `plan_one` inserts `__store` into an ssr job's inputs only when ctx has it. Absent ≡ `null` on every side (Rust `Option<Node>`, TS `inputs.__store ?? null`). Why: C5's literal "C1 object or `null`" would add `"__store":null` to every ssr job of every page. That changes every ssr job key, the `pokedex_plans_match_the_golden` plan descriptions and the jobs-request bytes on pages that touch no store, which the byte-identical rule forbids. Default: ACCEPT (record as a C5 clarification).
- **R2 — store modules are touched through `jobs.js`.** `buildJobs` emits `export const stores = { "<C3 path>": <namespace of that module> }` (static imports, resolved at build against `appRoot`). The worker passes it to `touchStores`. Emitted only when non-empty, so `jobs.js` stays byte-identical for apps with no stores. Records are keyed by store name in the scope (0.1.x), so the `jobs.js` copy of a store module and the loader's source copy resolve to one record. Default: ACCEPT. Alternative: a new `BRUST_APP_ROOT` env set by `run.ts` + `dist/index.js` and a runtime `import()`, which adds an env and per-boot dynamic imports.
- **R3 — a `notFound` verdict carries `store`.** It renders the route's templates (`pipeline.rs:401-405`), and 0.1.x seeds it too (`runtime/routes.ts:1213-1222`: the snapshot is collected before the verdict branch). Redirect, httpError and error carry none. Default: ACCEPT.
- **R4 — no runtime tag, no store tags.** A chain with no dynamic component gets no assets (`render.rs:337-339`), so its store tags are dropped too: nothing on that page could read them. Default: ACCEPT.
- **R5 — the out-of-scope message is 0.1.x verbatim.** It reads `store '<name>' accessed outside a request scope` (`brust/runtime/store/server-context.ts:26`). Design §4 quotes `"<name>: used outside a request scope"` as "0.1.x text", but the 0.1.x source says otherwise. The ported test matches `/outside a request scope/`, so both pass. Default: 0.1.x verbatim.
- **R6 — an explicit `cache({ key })` on a react component keeps its user key.** `plan_key` (:1431-1449) ignores the inputs when a user key is set. Such a job's cache entry does not follow `__store`. That is the developer's explicit choice (as with any other input), and `invalidate({key})` must still address it. Documented in the READY note for the dogfood docs. Default: ACCEPT.

## Global Constraints

- **Lane:** `cd ~/code/brust-m3f && git pull --ff-only && git worktree add ../brust-lane-m3f-store-server -b lane/m3f-store-server m3f && cd ../brust-lane-m3f-store-server && bun install --frozen-lockfile` (NOT `conclave lane start`, which branches from `main`). All line numbers are at m3f @ 3342353. If code moved, re-anchor on the quoted text and say so in the task note.
- NO PR. READY goes on the Conclave task, and the lead merges into `m3f` (design §7). **Merge order: `m3f-store-core` first.** S1–S7 need nothing from core and run immediately. S8–S9 start with `git merge origin/m3f` after core is merged. S10 runs after the compiler lane merges.
- **TDD:** every task writes its failing test first, runs it and pastes the failure, then implements.
- **Contracts are verbatim** (C1–C7). A lane that needs a different value files a `task challenge` (R1 is that challenge, pre-filed).
- **Byte-identical for every route that touches no store:**
  - Copy `/private/tmp/claude-501/-Users-detoro-code-brust/84499717-7bab-40dc-be3d-c896c07cf5ce/scratchpad/m3p-d/{snap,cmp}.sh` (the M3-P snapshot pair also used by `docs/plans/2026-10-11-m3p-e-tail.md` §Global) to `$OUT`, and set `ROOT=` to your lane.
  - Run `$OUT/snap.sh before` at the lane base (S1). After every code task run `$OUT/snap.sh sN && $OUT/cmp.sh before sN`, which must print `IDENTICAL` ×4: pokedex `/` and `/pokemon/pikachu`, bench `/dex` and `/team`, all `?nocache=1`, identity, chunk hashes stripped by the script.
  - Also `grep -c data-brust-store $OUT/body-sN-*` → 0 for each file. A page with no stores emits NO tag and identical bytes.
- **Stale addon:** after ANY Rust edit, `cd packages/brust && bun run build:debug` before any TS test (memory `stale-napi-node-after-compiler-change`). After the compiler lane merges into `m3f` and you merge it, rebuild again: a stale gitignored `.node` silently keeps the old compiler and server.
- Never `git add -A`; stage by name. `git status --short` before each commit lists exactly the task's files. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Gates** (green before each code commit; all before READY):
  - `cargo fmt --all -- --check`
  - `cargo clippy -p brust-server -p brust-napi --no-deps -- -D warnings`
  - `cargo test -p brust-server` (run `--test single_roundtrip` and `--test plan_offer` alone if a combined run flakes on a port)
  - `cargo test -p brust-server --test inputs job_keys_are_pinned` (must stay green with NO fixture regeneration)
  - `cargo test -p brust-napi`
  - `cargo bench -p brust-server --bench render --no-run`
  - `cd packages/brust && bun run build:debug && bun run typecheck && bun test` (server-starting files alone on a port flake: `test/e2e.test.ts`, `test/e2e-store.test.ts`, `test/napi-server.test.ts`, `test/cli.test.ts`)
  - `cd packages/runtime-dom && bun run typecheck && bun test` (after S8: proves the core lane's suite still passes beside your adapter)
  - `cd examples/pokedex && bun test && bun run typecheck`
  - `bun test --timeout 120000 tests/server/pokedex.test.ts`, then alone `bun test --timeout 120000 tests/server/hydrate.chromium.test.ts`
  - `bun check -p bench && bun test bench/lib`
- **Boundary (exact):**
  - `crates/brust-server/src/protocol.rs`: `LoaderResponse::Ok` (:39-45), `Verdict::NotFound` (:156-159), the visitor (:73-146), and its unit tests.
  - `crates/brust-server/src/pipeline.rs`, ONLY:
    - `STORE_KEY` + `PROPS_HIDDEN` (:877) + `is_server_slot` (:902-912);
    - a new `merge_loader_response` next to `merge_loader_data` (:935);
    - the Ok/NotFound arms of `page()` (:384-405);
    - `plan_response` (:1721-1760);
    - `collect_jobs`/`plan_one` (:1452-1563);
    - `render_document`'s inject call (:706);
    - unit tests in `mod tests`.
  - `crates/brust-server/src/render.rs`: new `inject_page_assets_into` + `store_scripts_into` beside `inject_assets_into` (:305-359). `inject_assets_into`/`inject_assets` keep their signatures and delegate with `None`, so `benches/render.rs` and `tests/render.rs` callers compile unchanged.
  - Tests: NEW `crates/brust-server/tests/store.rs`; additions to `tests/render.rs`, `tests/manifest.rs`.
  - TS:
    - NEW `packages/brust/src/store/server-context.ts` and `packages/brust/src/store/core-adapter.ts`;
    - `packages/brust/src/worker.ts`;
    - `packages/brust/src/build/bundle.ts` and `packages/brust/src/build/index.ts` (:147-151 only).
  - TS tests: NEW `packages/brust/test/{store-server-context,worker-store,build-store,e2e-store}.test.ts` + NEW fixtures `packages/brust/test/fixtures/{store-bundle,store-app}/`, `packages/brust/test/fixtures/safety/so-core-server/`.
  - CI: `.github/workflows/ci.yml` packages/brust job lines :120-124 (add the new files).
  - NOT touched:
    - `crates/brust-napi/**` (no change expected; it is rebuilt and its tests run);
    - `crates/brust-server/src/{manifest.rs,inputs.rs,dispatch.rs,pool.rs}`;
    - `packages/brust/src/build/manifest.ts` (the compiler lane writes `stores` there);
    - `packages/runtime-dom/**` and `packages/brust/src/store/index.ts` (core lane);
    - `crates/brust-compiler/**`;
    - `bench/**`, `crates/brust-server/benches/fixtures/**`.
- **Do not re-decide:** D1–D10, the `| e` contract, `inputs::job_key` bytes, P6's plan offer and `plan_in_call` shape (a field rides in it; nothing else changes), and the L1 rules (opt-in per route; a per-user page cached in L1 is a developer error with or without stores, D5).

## Review Focus

1. **Isolation across concurrent requests in the shared worker.** One Bun worker serves `BRUST_RENDER_SLOTS` loader calls interleaved on one isolate. Each `loader()` call and each ssr `runJob` opens its OWN `runInStoreContext` scope (a fresh `Map` per scope). No module-level mutable store state exists in `server-context.ts` beyond the `AsyncLocalStorage` instance. Pinned by:
   - the ported `INTERLEAVE ISOLATION` test;
   - `worker-store.test.ts` "two interleaved loader calls snapshot their own writes" (delays 20 ms / 1 ms, reversed completion order);
   - "an ssr job never sees the loader scope", which runs the planned path: jobs execute after the loader scope closed and must use their seeded scope.
2. **The snapshot reaches L1 with the page.** `__store` is in ctx before `render_document` on both paths, the tag is in `RenderedBody.html`, and a HIT replays it. Pinned by `tests/store.rs::l1_hit_serves_the_same_store_tag` (MISS then HIT, bodies `==`, loader calls stay 1) and `planned_and_declined_paths_render_the_same_bytes`.
3. **The ssr job key includes `__store`.** It is inserted into `projected` BEFORE `plan_key` (`plan_one` :1463-1475). Precompute inputs never contain it (F4). Pinned by:
   - `tests/store.rs::ssr_job_cache_follows_the_store` (count 3 → miss, 3 → hit, 4 → miss: `f.counts().1 == 2`);
   - `precompute_inputs_never_carry_the_store`;
   - the unit test `ssr_jobs_get_the_store_and_precompute_jobs_do_not`;
   - `job_keys_are_pinned` unchanged.
4. **Injection byte order.** The order is `[store tags sorted by name] → runtime tag → native chunks → react bundle → island chunks`, all before the last `</body>`. With `store = None`, `{}`, or a static chain, the output is byte-equal to today's `inject_assets_into`. Pinned by `tests/render.rs::store_tags_sit_immediately_before_the_runtime_tag`, `no_store_is_byte_identical` (the old tests run unmodified) and the snapshot `IDENTICAL` ×4.
5. **Escaping.**
   - JSON: `<` `>` `&` U+2028 U+2029 → `< > &    ` after serde_json serialisation (serde_json leaves all five raw, like `JSON.stringify`).
   - Name: only `[A-Za-z0-9_.:-]` kept (0.1.x strips, it does not reject); an empty result is skipped with a `warn`.
   - Pinned by `store_json_is_script_safe` (`</script><!--&  ` round-trips to `</script><!--&  `), `store_names_are_stripped` (`a"b<c` → `abc`, `"` never reaches the attribute) and an end-to-end variant in `tests/store.rs`.
6. **The planned-call envelope.**
   - `store` is parsed by the one visitor (`protocol.rs`) for both the declined response and the `plan_in_call` bytes.
   - `plan_response` calls the same `merge_loader_response` as `page()`, so `PlannedCall.ctx` already holds `__store` and `collect_jobs` sees it.
   - A `{planned:true}` reply carries no `store`, and none is needed.
   - Pinned by `planned_and_declined_paths_render_the_same_bytes` (bound vs unbound FakeBun: identical body AND identical `last_jobs()` JSON) and the protocol unit test `planned_ignores_store`.

## Dispatch table

| slug-task | tier | role | deps | acceptance (gate commands + READY evidence) |
|---|---|---|---|---|
| `m3f-store-server-1` lane + baseline + protocol field | routine | implementer | lane created; R1–R6 answered | `$OUT/snap.sh before` saved; protocol unit tests (store on Ok/NotFound, absent/null → None, planned ignores) red then green; `cargo test -p brust-server` green; commit `feat(server): LoaderResponse.store on ok and notFound (M3-F C2)` |
| `m3f-store-server-2` ctx `__store` on both paths | standard | implementer | S1 | `tests/store.rs` render + drop + notFound + planned/declined tests green; `loader_data_cannot_fill_server_slots` extended; `props_view` hides `__store`; IDENTICAL ×4; commit `feat(server): reserved ctx key __store from the loader snapshot, declined and planned paths (M3-F C1, D5)` |
| `m3f-store-server-3` ssr inputs `__store` | standard | implementer | S2 | `ssr_jobs_get_the_store_and_precompute_jobs_do_not`, `ssr_job_cache_follows_the_store`, `precompute_inputs_never_carry_the_store` green; `job_keys_are_pinned` + `pokedex_plans_match_the_golden` unchanged; IDENTICAL ×4; commit `feat(server): ssr job inputs carry __store (M3-F C5, D8)` |
| `m3f-store-server-4` store tags | standard | implementer | S2 | render tests (order, sorted, escaping, names, None/{} identical, static chain) + `tests/store.rs` tag/L1/escape tests green; old `tests/render.rs` unmodified and green; `cargo bench … --no-run`; IDENTICAL ×4 and 0 `data-brust-store`; commit `feat(server): data-brust-store script tags before the runtime tag (M3-F C4, D6)` |
| `m3f-store-server-5` server-context | standard | implementer | lane created | `test/store-server-context.test.ts` (4 ported + 6 new) green; `server-context.ts` imports nothing from core at runtime (`grep -n "from '@brust" src/store/server-context.ts` → only `import type`); commit `feat(core): per-request store scope — runInStoreContext, getServerInstance, collectSnapshot, touchStores (M3-F D4)` |
| `m3f-store-server-6` bundle aliases + regex + jobs table | complex | implementer | lane created | `test/build-store.test.ts` green: island + native chunks import the runtime URL, no runtime-dom copy outside the runtime file; `@brust/core/server` in an island fails `server-only-in-client`; `jobs.js` `stores` table present iff stores; no-store app `jobs.js` byte-identical (sha before/after on pokedex + bench app); existing `build-*.test.ts` green; IDENTICAL ×4; commit `feat(build): one runtime instance per page — island/native builds alias the store core to the runtime URL; @brust/core server-only regex; jobs.js stores table (M3-F D3, C6)` |
| `m3f-store-server-7` worker scope + touch + ssr seed | complex | implementer | S5, S6 | `test/worker-store.test.ts` (fake records, no core) green incl. interleave + planned path; `test/worker.test.ts` unchanged and green; no-store loader JSON byte-identical (test); IDENTICAL ×4; commit `feat(core): worker loader chain in a store scope, touched manifest stores, LoaderResponse.store, seeded ssr scope (M3-F D4, D8)` |
| `m3f-store-server-8` core adapter (after core merge) | standard | implementer | S7; `m3f-store-core` merged into m3f | `git merge origin/m3f` clean; adapter = the only file importing core; real-`defineStore` tests green (loader `cart.count.set(3)` → `store:{cart:{count:3}}`; ssr job sees seeded 3; `@brust/core/store` and `@brust/runtime-dom/store` are one module in the worker); core's own suite green; commit `feat(core): register the server store resolver at worker boot (M3-F, core adapter)` |
| `m3f-store-server-9` e2e + perf sanity + READY | standard | implementer | S8 | `test/e2e-store.test.ts` green alone ×3 (real CLI, 2 workers): tag once per store before runtime, MISS→HIT same bytes, no-store page no tag; ci.yml lists the 4 new files; lane A/B D/I/S (3 rounds) rps ≥ −1% (else STOP, Risk L2); all gates; READY |
| `m3f-store-server-10` post-compiler verification | routine | implementer | S9 merged; `m3f-store-compiler` merged | on m3f: `bun run build:debug` (fresh addon); pokedex/bench IDENTICAL ×4; a compiled `useStore` native component's manifest `stores` reaches `touchStores` (e2e-store fixture gains one native `useStore` read: first paint = loader-written value); note on the task (no READY; lead merges) |

## File structure

```
crates/brust-server/src/protocol.rs     LoaderResponse::Ok + Verdict::NotFound gain `store: Option<Node>`; visitor reads "store"
crates/brust-server/src/pipeline.rs     STORE_KEY; is_server_slot; PROPS_HIDDEN += STORE_KEY; merge_loader_response (3 call sites);
                                        collect_jobs passes ctx.__store to plan_one; plan_one inserts it into ssr inputs; render_document → inject_page_assets_into
crates/brust-server/src/render.rs       inject_page_assets_into(html, chain, m, store); store_scripts_into; inject_assets_into delegates (None)
crates/brust-server/tests/store.rs      NEW: FakeBun integration (temp_dist + jinja overrides)
crates/brust-server/tests/render.rs     + store tag tests (old tests unchanged)
crates/brust-server/tests/manifest.rs   + component `stores` is accepted (F9 guard)
packages/brust/src/store/server-context.ts   NEW: AsyncLocalStorage scope, seed-on-create, collectSnapshot, touchStores (no runtime core import)
packages/brust/src/store/core-adapter.ts     NEW: expected core shapes + isStoreHandle (S5); installServerResolver (S8) — the ONLY core import
packages/brust/src/worker.ts            LoaderResponse.store; ManifestLike routes/children/stores; routeStoresIndex; loader in scope; ssr seeded scope; strip __store
packages/brust/src/build/bundle.ts      runtimeAliasPlugin (client + island builds); regex @brust/core; buildJobs: stores table + runtime-dom/store → @brust/core/store
packages/brust/src/build/index.ts       writeManifest before buildJobs; pass the store-module union
packages/brust/test/{store-server-context,worker-store,build-store,e2e-store}.test.ts   NEW
packages/brust/test/fixtures/{store-bundle,store-app,safety/so-core-server}/              NEW
.github/workflows/ci.yml                packages/brust job lists the new files
```

---

### Task S1: Lane, baseline snapshots, `store` on the wire (Rust)

**Files:** Modify `crates/brust-server/src/protocol.rs`.

- [ ] **Step 1: Lane + baseline.** Create the lane (Global). `export OUT=<your scratchpad>/m3f-server && mkdir -p $OUT`, copy `snap.sh`/`cmp.sh`, set `ROOT`, then `cd packages/brust && bun run build:debug && cd ../..` and `$OUT/snap.sh before`. Paste `wc -c $OUT/body-before-*`.
- [ ] **Step 2: Failing tests** (`protocol.rs` `mod tests`):
  - `loader_ok_carries_store_and_absent_or_null_is_none`: `{"ok":true,"data":{},"store":{"cart":{"count":1}}}` → `Ok{store: Some(Node::from(json!({"cart":{"count":1}})))}`. `{"ok":true,"data":{}}` and `{"ok":true,"data":{},"store":null}` → `store: None`.
  - `not_found_carries_store`: `{"verdict":"notFound","data":{"a":1},"store":{"s":{"k":2}}}` → `Verdict::NotFound{data, store: Some(..)}`; without `store` → `None`.
  - `planned_ignores_store`: `{"planned":true,"store":{"s":{}}}` → `Planned{results: []}`.
  - Update the existing `assert_eq!`s that build `LoaderResponse::Ok{…}` / `Verdict::NotFound{…}` with `store: None` (:225-257). The asserted JSON inputs stay unchanged.
- [ ] **Step 3: Implementation.**
```rust
    Ok {
        ok: bool,
        data: Node,
        headers: BTreeMap<String, String>,
        /// M3-F C2: the request's store snapshot (C1: `{ name: { key: Json } }`). `None` when the
        /// worker sent no `store` or `null` (R1: absent ≡ null).
        store: Option<Node>,
    },
```
  - In the visitor: `let mut store = None::<Node>;` plus the arm `"store" => store = m.next_value::<Option<Node>>()?,`.
  - Pass `store` into `LoaderResponse::Ok { …, store }` and into `Verdict::NotFound { data: data.unwrap_or_default(), store }`.
  - `Verdict::NotFound { #[serde(default)] data: Node, #[serde(default)] store: Option<Node> }`.
  - Fix the compile errors in `pipeline.rs` with `..`/`store: _` ONLY for now (S2 wires them). The bench at `benches/render.rs:289-315` needs no change.
- [ ] **Step 4:** Run `cargo test -p brust-server` and the gates. Commit `feat(server): LoaderResponse.store on ok and notFound (M3-F C2)`.

### Task S2: ctx `__store` on the declined AND planned paths

**Files:** Modify `crates/brust-server/src/pipeline.rs`. Create `crates/brust-server/tests/store.rs`.

- [ ] **Step 1: Failing integration tests** (`tests/store.rs`, `mod common; use common::*;`).
  - Helper `store_dist()` = `temp_dist(|_| {})`, then overwrite `jinja/detailPage_c3.jinja` with today's text with `<b id="c">{{ __store.cart.count | e }}</b>` inserted before `</main>`. Helper `with_store(snap: Value) -> impl Fn(Value) -> Value`, which returns `default_loader(req)` plus `"store": snap`.
  - Helper `boot_unbound(fake, dir)`: `start(config(dir))` + `register_worker(Box::new(FakeBunHandle(fake)))` WITHOUT `fake.bind`. An unbound fake ignores the plan offer, so it exercises the declined two-call path.
  - `loader_store_renders_from_ctx`: r2 `/pokemon/pikachu` with `{"cart":{"count":3}}` → body contains `<b id="c">3</b>`.
  - `planned_and_declined_paths_render_the_same_bytes`: the same request on a bound and an unbound server. Bodies `==`, both contain `<b id="c">3</b>`, and `bound.last_jobs() == unbound.last_jobs()`.
  - `loader_key___store_is_dropped`: data `{"__store": {"cart": {"count": 9}}}`, no `store` → `<b id="c"></b>` (minijinja undefined prints empty).
  - `not_found_verdict_carries_the_store`: loader returns `{"verdict":"notFound","data":{"pokemon":{"name":"x","stats":{"hp":1},"moves":[]}},"store":{"cart":{"count":5}}}` → status 404, body contains `<b id="c">5</b>`.
  - Unit tests in `pipeline.rs`:
    - extend `loader_data_cannot_fill_server_slots` (:2720) input with `"__store": {"x": {}}` (expected output unchanged);
    - new `merge_loader_response_keeps_only_a_non_empty_map` (`Some(map)` → inserted; `None`, `Some(Null)`, `Some({})`, `Some("x")` → no key);
    - new `props_view_hides_the_store` (`{{ _props | json_attr }}` over a ctx with `__store` has no `__store`).
- [ ] **Step 2: Implementation.**
```rust
/// Reserved ctx key (M3-F C1, D5): the request's store snapshot `{ name: { key: Json } }`, from
/// `LoaderResponse.store`. Absent when no store was touched (R1). Templates read
/// `__store.<name>.<key>`; `render_document` turns it into `data-brust-store` tags.
pub(crate) const STORE_KEY: &str = "__store";
```
  - `PROPS_HIDDEN` (:877) → `&[CHILDREN_KEY, OWN_KEY, STORE_KEY]` (F4).
  - `is_server_slot` (:907) → `matches!(k, "__outlet" | CHILDREN_KEY | OWN_KEY | PROPS_KEY | STORE_KEY)`, with the doc comment's list extended.
```rust
/// Loader `data` (server slots dropped, as `merge_loader_data`), then the store snapshot at
/// [`STORE_KEY`] when it is a non-empty map. One helper for `page()`'s Ok and NotFound arms and
/// `plan_response`, so the declined and the planned path build the same ctx (F5).
fn merge_loader_response(ctx: &mut MapInner, data: Node, snapshot: Option<Node>, route: &str) {
    merge_loader_data(ctx, data, route);
    match snapshot {
        Some(Node::Map(m)) if !m.0.is_empty() => {
            ctx.insert(STORE_KEY.into(), Node::Map(m));
        }
        None | Some(Node::Null) | Some(Node::Map(_)) => {}
        Some(_) => tracing::warn!(route, "loader response store is not an object; dropped"),
    }
}
```
  (`Node::Map(Arc<CtxMap>)`, `CtxMap(pub MapInner)`: `ctx.rs:20-32`. Add no API to brust-jinja.)
  - Call sites:
    - `:384` `Ok(LoaderResponse::Ok { ok: true, data, headers, store: snapshot }) => { merge_loader_response(&mut ctx, data, snapshot, &route.id); …`
    - `:401` `Verdict::NotFound { data, store: snapshot }` → `merge_loader_response`
    - `plan_response` (:1728-1736): destructure `store: snapshot`, `merge_loader_response(&mut base, data, snapshot, &route.id)`.
- [ ] **Step 3:** Run `cargo test -p brust-server` (`--test store`, `--test single_roundtrip`, `--test plan_offer` alone too), then `bun run build:debug`, snapshots `IDENTICAL` ×4 and the gates. Commit `feat(server): reserved ctx key __store from the loader snapshot, declined and planned paths (M3-F C1, D5)`.

### Task S3: ssr job inputs carry `__store` (C5, D8)

**Files:** Modify `pipeline.rs` (`collect_jobs` :1503-1563, `plan_one` :1452-1494). Tests in `pipeline.rs` `mod tests` and `tests/store.rs`.

- [ ] **Step 1: Failing tests.**
  - Unit `ssr_jobs_get_the_store_and_precompute_jobs_do_not`: manifest from `manifest()`, chain `["teamPage_g7"]` (ssr child via `props` map), ctx = `pikachu()` + `"team": ["a"]` + `__store` = `{"cart":{"count":3}}`. `plans[0].inputs == {"team":["a"],"__store":{"cart":{"count":3}}}`. Then set `detailPage_c3.jobs[0].inputs = ["*"]` (precompute, as `star_input_is_every_prop` :2674 does): its inputs equal `pikachu()` with NO `__store`. With no `__store` in ctx the ssr inputs are exactly `{"team":["a"]}` (R1).
  - `tests/store.rs::ssr_job_cache_follows_the_store`: r5 `/team` (no L1), loader `store` count read from an `Arc<AtomicU32>`. Requests at 3, 3, 4 → `f.counts().1 == 2`, and `last_jobs()["jobs"][0]["inputs"]["__store"] == {"cart":{"count":4}}`.
  - `precompute_inputs_never_carry_the_store`: r2 with a store → every `last_jobs()` call's `inputs` has no `__store` key.
  - `island_props_hide_the_store`:
    - `temp_dist` adds route `{"id":"r7","pattern":"/island","chain":["appLayout_a1","teamBuilder_h8"],"loaders":["r7"],"cache":null,"catch_all":false}`;
    - loader `default_loader` + store;
    - the body's `x-props='…'` contains no `__store`, and `last_jobs()` `teamBuilder_h8/ssr` inputs contain `__store` (the `"*"` shape).
    - `default_job` already answers `("teamBuilder_h8","ssr")` when `target` matches.
- [ ] **Step 2: Implementation.** In `collect_jobs` take `let snapshot = ctx.get(STORE_KEY);` once and pass it to every `plan_one` call (chain and child loops). In `plan_one` (signature `…, src: PlanSrc, snapshot: Option<&Node>`; it already has `#[allow(clippy::too_many_arguments)]`):
```rust
    let mut projected = job_inputs(j, props, per_instance)?;
    // M3-F C5/D8: every ssr job renders inside a store scope seeded from `__store`, so the
    // snapshot is one of its inputs (and of its hashed key). Precompute jobs never see stores.
    if j.kind == JobKind::Ssr
        && let Some(st) = snapshot
        && let Some(m) = projected.map_mut()
    {
        m.insert(Arc::from(STORE_KEY), st.clone());
    }
```
  The insert happens before `plan_key` (key covers it). `st.clone()` is an `Arc` bump. A non-map projection (a scalar props node) gets nothing. Log at `debug` once; this does not happen for compiler-emitted ssr jobs.
- [ ] **Step 3:** `cargo test -p brust-server` must show `pokedex_plans_match_the_golden`, `plan_response_*` and `job_keys_are_pinned` unchanged. Then snapshots and gates. Commit `feat(server): ssr job inputs carry __store (M3-F C5, D8)`.

### Task S4: `data-brust-store` tags before the runtime tag (C4, D6)

**Files:** Modify `crates/brust-server/src/render.rs` (beside :305-364) and `pipeline.rs:706`. Tests in `tests/render.rs`, `tests/store.rs`.

- [ ] **Step 1: Failing tests** (`tests/render.rs`, import `brust_server::render::{inject_page_assets_into, store_scripts_into}` and `brust_jinja::ctx::Node`):
  - `store_tags_sit_immediately_before_the_runtime_tag`: chain `appLayout_a1, detailPage_c3`, store `{"b":{"v":1},"a":{"v":2}}`. The output ends with `<script type="application/json" data-brust-store="a">{"v":2}</script><script type="application/json" data-brust-store="b">{"v":1}</script><script type="module" src="/_brust/client/runtime-8b1c.js"></script><script type="module" src="/_brust/client/detailPage_c3-1a2b3c.js"></script></body></html>`.
  - `no_store_is_byte_identical`: for each fixture chain × html in {with `</body>`, without}, the result is `==` to `inject_assets` for `store` ∈ {`None`, `Some(Null)`, `Some({})`}.
  - `static_chain_ignores_the_store` (R4): chain `appLayout_a1, homePage_b2` + a store → output `==` input.
  - `store_json_is_script_safe`: state `{"s":"</script><!--&\u{2028}\u{2029}>"}` → the text `{"s":"</script><!--&  >"}`; the rendered output contains no `</script><!--` beyond the tag's own close.
  - `store_names_are_stripped`: name `a"b<c d` → `data-brust-store="abcd"`; name `"<>"` → no tag (and no panic).
  - `tests/store.rs`:
    - `store_tag_once_per_store_on_the_page` (r2, two stores, each name appears exactly once, the tags sit immediately before `runtime-8b1c.js`);
    - `l1_hit_serves_the_same_store_tag` (r2 is L1-cached ttl 60: MISS then HIT, `x-brust-cache` MISS/HIT, bodies `==`, `f.counts().0 == 1`);
    - `no_store_page_has_no_tag_and_same_bytes` (a loader without `store` vs the same with `"store": null` on two servers: bodies `==`, no `data-brust-store`);
    - `request_derived_store_value_cannot_break_out` (store value = the request's `name` param `%3C%2Fscript%3E` → decoded `</script>` is escaped in the tag).
- [ ] **Step 2: Implementation** (`render.rs`):
```rust
/// [`inject_page_assets_into`] without a store snapshot — today's S9 injection, byte for byte.
pub fn inject_assets_into(html: &mut String, chain: &[String], m: &Manifest) {
    inject_page_assets_into(html, chain, m, None);
}

/// S9 + M3-F C4/D6: as before, preceded by one `data-brust-store` tag per store in `store`
/// (the ctx `__store` map; sorted by name: `MapInner` is a BTreeMap) — immediately before the
/// runtime tag, so the snapshot is in the DOM before `mount()` and before any island hydrates.
/// No tags at all when the chain has no dynamic component (R4).
pub fn inject_page_assets_into(html: &mut String, chain: &[String], m: &Manifest, store: Option<&Node>) {
    // … the existing body of inject_assets_into, with:
    let mut tags = String::new();
    if let Some(st) = store {
        store_scripts_into(&mut tags, st);
    }
    tags.push_str(&tag(&m.assets.runtime));
    // … rest unchanged
}

/// 0.1.x `storeScriptTag` × each store: `<script type="application/json" data-brust-store="NAME">`
/// + script-safe JSON + `</script>`. NAME keeps `[A-Za-z0-9_.:-]` only (an emptied name is skipped);
/// the JSON escapes `< > & U+2028 U+2029` as `\uXXXX` (0.1.x `toScriptJson`; AutoEscape::None and a
/// request-derived value can reach a signal).
pub fn store_scripts_into(out: &mut String, store: &Node) {
    let Node::Map(m) = store else { return };
    for (name, state) in m.0.iter() {
        let clean: String = name
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '-'))
            .collect();
        if clean.is_empty() {
            tracing::warn!(store = %name, "store name has no [A-Za-z0-9_.:-] character; snapshot not injected");
            continue;
        }
        out.push_str("<script type=\"application/json\" data-brust-store=\"");
        out.push_str(&clean);
        out.push_str("\">");
        let json = serde_json::to_string(state).expect("Node serialises");
        for c in json.chars() {
            match c {
                '<' => out.push_str("\\u003c"),
                '>' => out.push_str("\\u003e"),
                '&' => out.push_str("\\u0026"),
                '\u{2028}' => out.push_str("\\u2028"),
                '\u{2029}' => out.push_str("\\u2029"),
                c => out.push(c),
            }
        }
        out.push_str("</script>");
    }
}
```
  `use brust_jinja::ctx::Node;` in render.rs. `pipeline.rs:706` → `inject_page_assets_into(&mut out, &route.chain, &s.manifest, ctx.get(STORE_KEY));` and the import at :31.
- [ ] **Step 3:** `cargo test -p brust-server` (the old `tests/render.rs` cases untouched and green), `cargo bench -p brust-server --bench render --no-run`, `bun run build:debug`, snapshots `IDENTICAL` ×4 + `grep -c data-brust-store` → 0, gates. In a scratch clone, `git apply --check bench/attribution.patch`; if it no longer applies (it instruments `render_document`), say so in the task note; do NOT regenerate it. Commit `feat(server): data-brust-store script tags before the runtime tag (M3-F C4, D6)`.

### Task S5: `store/server-context.ts` + `store/core-adapter.ts` (no core import yet)

**Files:** Create `packages/brust/src/store/server-context.ts`, `packages/brust/src/store/core-adapter.ts`, `packages/brust/test/store-server-context.test.ts`.

- [ ] **Step 1: Failing tests.**
  - Port verbatim the four tests of `/Users/detoro/code/brust/runtime/store/server-context.test.ts`: fresh map per scope / create once; outside scope throws `/outside a request scope/`; `collectSnapshot` touched-only, `null` when none; INTERLEAVE ISOLATION. The `makeRecord` fake gains `handle.hydrate(s) { value = s.value }`.
  - New:
    - `seeded scope hydrates a record on creation`: `runInStoreContext(() => getServerInstance('alpha', …).value, { alpha: { value: 9 } })` → 9;
    - `seed for an untouched name creates nothing` (`collectSnapshot()` → `null` inside a seeded scope before any access);
    - `nested scopes are independent` (inner writes invisible outside);
    - `touchStores resolves every store handle a module exports` (module `{ cart: fakeHandle, helper: () => 1, n: 3 }` → `fakeHandle` called once, `helper` never);
    - `touchStores warns once for a module missing from the table and does not throw`;
    - `isStoreHandle duck-types C8 members` (function with `subscribe`/`snapshot`/`serialize`/`hydrate` functions and a string `name` → true; a plain function → false).
- [ ] **Step 2: Implementation.**
```ts
// packages/brust/src/store/core-adapter.ts — the ONE file that names the store-core lane's API
// (design §2.1, C7/C8). Until m3f-store-core merges it holds only the shapes this lane expects;
// S8 adds the import. A mismatch with core is fixed here, in one line.

/** C1: `{ [storeName]: { [signalKey]: Json } }`. */
export type StoreSnapshot = Record<string, Record<string, unknown>>

/** What core's server-side `create()` returns (0.1.x `StoreInstanceRecord` + `handle`). EXPECTED of core:
 * `handle.serialize()` = top-level signal values (D1); `handle.hydrate(s)` sets signals, ignores unknown keys. */
export interface StoreRecord {
  instance: object
  handle?: { serialize(): Record<string, unknown>; hydrate(state: Record<string, unknown>): void }
}

/** EXPECTED core hook: `__setServerResolver(fn: ServerResolver)` exported by `@brust/runtime-dom/store`. */
export type ServerResolver = (name: string, create: () => StoreRecord) => StoreRecord

/** A `defineStore` handle (C8 reserved members). Duck-typed: core exports no brand for handles. */
export function isStoreHandle(v: unknown): v is (() => object) & { readonly name: string } {
  if (typeof v !== 'function') return false
  const h = v as unknown as Record<string, unknown>
  return typeof h.name === 'string' && ['subscribe', 'snapshot', 'serialize', 'hydrate'].every((k) => typeof h[k] === 'function')
}
```
```ts
// packages/brust/src/store/server-context.ts — the per-request store scope (design D4, D8). Server-only;
// never imported by client code. No runtime import from core: `core-adapter.ts` registers
// `getServerInstance` as core's resolver at worker boot (S8).
import { AsyncLocalStorage } from 'node:async_hooks'
import { isStoreHandle, type StoreRecord, type StoreSnapshot } from './core-adapter'

interface Scope { records: Map<string, StoreRecord>; seed: StoreSnapshot | null }
const storeContext = new AsyncLocalStorage<Scope>()

/** Runs `fn` in a fresh scope. `seed` (an ssr job's `inputs.__store`) hydrates each store on its first access. */
export function runInStoreContext<T>(fn: () => T, seed: StoreSnapshot | null = null): T {
  return storeContext.run({ records: new Map(), seed }, fn)
}

export function getServerInstance(name: string, create: () => StoreRecord): StoreRecord {
  const scope = storeContext.getStore()
  if (!scope) throw new Error(`store '${name}' accessed outside a request scope`) // R5: 0.1.x verbatim
  let rec = scope.records.get(name)
  if (!rec) {
    rec = create()
    scope.records.set(name, rec) // before hydrate: handle.hydrate resolves back to this record
    const s = scope.seed?.[name]
    if (s && typeof s === 'object') rec.handle?.hydrate(s)
  }
  return rec
}

/** Touched stores only; `null` when none (C2: then `store` is omitted, R1). */
export function collectSnapshot(): StoreSnapshot | null {
  const scope = storeContext.getStore()
  if (!scope || scope.records.size === 0) return null
  const out: StoreSnapshot = {}
  for (const [name, rec] of scope.records) out[name] = rec.handle ? rec.handle.serialize() : {}
  return out
}

const warned = new Set<string>()
/** D4: resolve every store handle exported by each module (C3 paths → `jobs.js` `stores` table, R2), so its
 * defaults are in the snapshot even if no loader touched it. Must run inside a scope. */
export function touchStores(modules: readonly string[], table: Readonly<Record<string, object>>): void {
  for (const p of modules) {
    const mod = table[p]
    if (!mod) {
      if (!warned.has(p)) { warned.add(p); console.warn(`[brust] store module ${p} is not in jobs.js (rebuild?)`) }
      continue
    }
    for (const v of Object.values(mod)) if (isStoreHandle(v)) v()
  }
}
```
- [ ] **Step 3:** `cd packages/brust && bun run typecheck && bun test test/store-server-context.test.ts` ×5 (interleave stability). Commit `feat(core): per-request store scope — runInStoreContext, getServerInstance, collectSnapshot, touchStores (M3-F D4)`.

### Task S6: Bundles — runtime alias for client + island builds, `@brust/core` server-only regex, `jobs.js` stores table

**Files:**
- Modify `packages/brust/src/build/bundle.ts` (:103, :217-233, :260-276, :281-319) and `packages/brust/src/build/index.ts` (:147-151).
- Create `packages/brust/test/build-store.test.ts`, `packages/brust/test/fixtures/store-bundle/` and `packages/brust/test/fixtures/safety/so-core-server/`.

- [ ] **Step 1: Fixtures.**
  - `fixtures/safety/so-core-server/`: `routes.tsx` + `Island.tsx`. The island uses `useReducer` (react tier, like `so-react/Counter.tsx`) and imports `{ cache } from '@brust/core/server'` (a value export, `src/server.ts:2`), using it in a handler (`cache.invalidate`). A type-only import is erased and would prove nothing.
  - `fixtures/store-bundle/`:
    - `store.ts` imports `{ signal } from '@brust/runtime-dom'` (exists today) and exports `export const hits = signal(0)`;
    - `Native.tsx` (useState + an onClick calling `hits.set(hits() + 1)`, so the native tier gets a client chunk);
    - `Island.tsx` (useReducer + reads `hits()`);
    - `routes.tsx` with `/n` and `/i`.
- [ ] **Step 2: Failing tests** (`build-store.test.ts`, same harness as `build-safety.test.ts:9-35`):
  - `@brust/core/server in an island fails server-only-in-client`: `rule: 'server-only-in-client'`, message contains `Island.tsx imports @brust/core/server`. Fails today (F8).
  - `island and native chunks import the store core from the runtime URL`. Build `store-bundle` and take `m.assets.runtime` (`client/runtime-<hex>.js`).
    - Among the files produced by the island build AND among those produced by the native build, the file that defines `hits` matches `/import\{[^}]*\bsignal\b[^}]*\}from"\/_brust\/client\/runtime-[0-9a-f]{10}\.js"/`. An external import keeps its export name under minify, so this proves `signal` is NOT bundled. `signal.ts` has no string literal to grep for; this is the stable check.
    - Today the island build fails this assertion (F7).
    - Add after S8: `Symbol.for("brust.reactive.ctx")` (C7) appears in exactly one `dist/client` file, the runtime.
  - `jobs.js has a stores table only when the manifest lists stores`:
    - (a) pokedex-like `fixtures/app` → `jobs.js` contains no `stores`, and its sha256 equals a build at the lane base;
    - (b) `store-bundle` with a manifest whose `components[*].stores = ['store.ts']`. Before the compiler lane, inject it by calling `buildJobs(out, compiled, sourceOf, appRoot, ['store.ts'])` directly → `import(out/jobs.js)` has `stores['store.ts'].hits` callable;
    - (c) a path escaping the app (`'../x.ts'`) or missing → `BuildError` `store-module`.
  - `jobs.js keeps @brust/runtime-dom/store on the worker's core`: a fixture component importing `@brust/runtime-dom/store` → `jobs.js` text contains `from "@brust/core/store"` (external) and no bundled copy. Before core merges, use a resolvable stand-in. The plugin maps the specifier WITHOUT resolving it, so the build passes even though the file does not exist yet. Assert on the output text.
- [ ] **Step 3: Implementation.**
```ts
// :103
  if (/^@brust\/core\/(server|native)(\/|$)/.test(spec)) return true

/** D3/C6: one runtime instance per page. Island and native client builds resolve the reactive core and
 * the store API to the runtime bundle URL (external), exactly as the compiler's `runtimeImport`. The
 * React bridge (`useStore`) is bundled (it holds no module state), but ITS imports of the core are the
 * runtime too. Registered after `serverOnlyPlugin`, before `sourceDirPlugin` (which would resolve the
 * bare specifiers to files). */
export function runtimeAliasPlugin(runtimeUrl: string): BunPlugin {
  return {
    name: 'brust-runtime-alias',
    setup(b) {
      b.onResolve({ filter: /^@brust\/(runtime-dom(\/store)?|core\/store)$/ }, () => ({ path: runtimeUrl, external: true }))
      let bridge: string | undefined
      b.onResolve({ filter: /^@brust\/(runtime-dom|core)\/store\/react$/ }, () => {
        bridge ??= Bun.resolveSync('@brust/runtime-dom/store/react', import.meta.dir) // core lane file; resolved lazily
        return { path: bridge }
      })
      b.onResolve({ filter: /^\.\.?\// }, (a) => (bridge !== undefined && a.importer === bridge ? { path: runtimeUrl, external: true } : undefined))
    },
  }
}
```
  - `buildClientChunks(dist, compiled, ctx, runtimeUrl)` → `plugins: [runtimeAliasPlugin(runtimeUrl), sourceDirPlugin(…)]`.
  - `buildReactChunks(dist, compiled, ctx, runtimeUrl)` → the same, plus `external: ['/_brust/*']`.
  - `browserBuild` puts `serverOnlyPlugin` first (:160), so the order is serverOnly → alias → sourceDir.
  - `buildJobs(dist, compiled, sourceOf, appRoot, stores: string[] = [])`:
    - for each `p` (sorted, unique): reject when `isAbsolute(p)` or `p.split('/').includes('..')`, or when `!existsSync(resolve(appRoot, p))` → `BuildError('store-module', …)`;
    - `imports.push(\`import * as S${i} from ${JSON.stringify(resolve(appRoot, p))}\`)`;
    - after the default export, only when `stores.length > 0`: `export const stores = {\n  "p": S0,\n}\n`;
    - add a plugin `{ onResolve /^@brust\/runtime-dom\/store(\/react)?$/ → { path: a.path.replace('@brust/runtime-dom', '@brust/core'), external: true } }` before `sourceDirPlugin` (F6).
  - `build/index.ts:147-151`:
```ts
  const runtimeUrl = `/_brust/${runtime}`
  const chunks = new Map([...(await buildClientChunks(out, compiled, ctx, runtimeUrl)), ...(await buildReactChunks(out, compiled, ctx, runtimeUrl))])
  const manifest = writeManifest({ leaves, routeComponent, compiled, runtime, chunks })
  await buildJobs(out, compiled, ctx.sourceOf, appRoot, storeModules(manifest))
```
  - `storeModules(m)` (exported from bundle.ts) = the sorted unique union of `(c as { stores?: string[] }).stores ?? []` over `m.components`, tolerant of the field's absence until the compiler lane lands (C3).
- [ ] **Step 4:** `cd packages/brust && bun run typecheck && bun test test/build-store.test.ts test/build-safety.test.ts test/build-manifest.test.ts test/build-compile.test.ts test/e2e-child-chunks.test.ts`. Rebuild `examples/pokedex` and `bench/apps/brust` before and after and compare `sha256sum dist/jobs.js` (equal) and the `dist/client` file count (equal). Then `IDENTICAL` ×4 and the gates. Commit `feat(build): one runtime instance per page — island/native builds alias the store core to the runtime URL; @brust/core server-only regex; jobs.js stores table (M3-F D3, C6)`.

### Task S7: Worker — loader chain in a scope, touch, `store` in the response, seeded ssr scope

**Files:** Modify `packages/brust/src/worker.ts` (:20-25, :56-60, :135-191, :243-259). Create `packages/brust/test/worker-store.test.ts`.

- [ ] **Step 1: Failing tests** (fake records through `getServerInstance`, no core):
  - `a loader write lands in LoaderResponse.store`: loader `() => { rec('cart', 0).value = 3; return { a: 1 } }` → `{ ok: true, data: { a: 1 }, store: { cart: { value: 3 } } }`.
  - `no store touched → no store key, byte-identical JSON`: `JSON.stringify(await h.loader(req))` equals the string today's `makeHandlers` produces for the same chain (`'store' in r === false`).
  - `notFound carries the store; redirect/httpError/error do not` (R3).
  - `two interleaved loader calls snapshot their own writes`: delays 20 ms / 1 ms, each writes its id → snapshots `{…:1}` / `{…:2}`.
  - `manifest stores are touched before the chain`: manifest `{routes:[{id:'r1',chain:['p']}], components:{p:{jobs:[],children:[{id:'k'}],stores:['s.ts']}, k:{jobs:[],stores:['t.ts']}}}`, `stores` table `{ 's.ts': { A: fakeHandle('a') }, 't.ts': { B: fakeHandle('b') } }`. A loader returning `{}` → `store` has `a` and `b` (children walked; job `target`s walked likewise).
  - `ssr job runs in a scope seeded from inputs.__store, and props lose __store`: an ssr fn reads `getServerInstance('cart', mk).value` and records the props it got. Inputs `{ team: [], __store: { cart: { value: 7 } } }` → value 7, `'__store' in props === false`.
  - `precompute jobs run outside any scope`: a precompute fn calling `getServerInstance` → that result is `{ error: /outside a request scope/ }`.
  - `an ssr job never sees the loader scope (planned path)`: `makeDispatch` with a `plan` stub returning a misses JSON whose ssr inputs carry `__store` → the ssr fn sees the seed, not the loader's records.
- [ ] **Step 2: Implementation.**
  - Types:
```ts
import { type StoreSnapshot } from './store/core-adapter'
import { collectSnapshot, runInStoreContext, touchStores } from './store/server-context'

export type LoaderResponse =
  | { ok: true; data: Record<string, unknown>; headers?: Record<string, string>; store?: StoreSnapshot | null }
  | { verdict: 'notFound'; data: unknown; store?: StoreSnapshot | null }
  | …

export interface ManifestLike {
  routes?: { id: string; chain: string[] }[]
  components: Record<string, { jobs: { id: string; kind?: string; target?: string; literals?: Record<string, unknown> }[]; children?: { id: string }[]; stores?: string[] }>
  jobs_module?: string
}
```
  - `routeStoresIndex(m)`: route id → sorted unique union of `stores ?? []` over the chain, walking each component's `children[].id` and `jobs[].target` transitively (a `seen` set). Routes with an empty union are not stored.
  - `withStore(r)` assigns `r.store = s` ONLY when `collectSnapshot()` is non-null (R1).
  - `loader(req)`: after the `leaf` lookup, `return runInStoreContext(async () => { …today's try body… })`.
    - First statement inside the `try`: `const touch = storeIdx.get(req.routeId); if (touch) touchStores(touch, storeTable)`.
    - `return withStore({ ok: true, data: merged })`; a notFound verdict → `withStore(verdictJson(r, merged))`.
    - Redirect/httpError/error unchanged.
  - `runJob`: for `kind === 'ssr'`, after the literals merge:
```ts
        const seed = (props?.__store ?? null) as StoreSnapshot | null
        if (props && '__store' in props) { const { __store: _, ...rest } = props; props = rest }
        return { id: call.id, value: await runInStoreContext(() => fn(props), seed) }
```
  - `makeHandlers` opts gain `stores?: Record<string, object>` (default `{}`). `startWorker` passes `stores: (jobsMod.stores ?? {}) as Record<string, object>`.
  - `makeDispatch` unchanged: `toJson(out)` already carries `store` into the slot and into `planJobs`.
- [ ] **Step 3:** `bun test test/worker-store.test.ts test/worker.test.ts` (worker.test.ts unmodified), typecheck, `bun run build:debug`, `IDENTICAL` ×4, gates. Commit `feat(core): worker loader chain in a store scope, touched manifest stores, LoaderResponse.store, seeded ssr scope (M3-F D4, D8)`.

### Task S8: Core adapter — register the resolver (after `m3f-store-core` merges)

**Files:** Modify `packages/brust/src/store/core-adapter.ts` and `packages/brust/src/worker.ts` (one import). Add tests to `worker-store.test.ts`.

- [ ] **Step 1:** `git merge origin/m3f`. Resolve nothing in core files. Run `bun install --frozen-lockfile` and `cd packages/runtime-dom && bun test` (green).
- [ ] **Step 2: Failing tests** (real core):
  - `defineStore in a loader → store snapshot`: `const cart = defineStore('cart', () => ({ count: signal(0) }))` from `@brust/core/store`; loader `cart.count.set(3)` → `store: { cart: { count: 3 } }`.
  - `a manifest-touched store contributes its defaults`.
  - `an ssr job reads the seeded value through the handle`: fn `() => String(cart.count())`, inputs `__store: { cart: { count: 4 } }` → `'4'`.
  - `the worker sees ONE store core`: `(await import('@brust/core/store')).defineStore === (await import('@brust/runtime-dom/store')).defineStore`.
  - `out of scope`: `cart.count()` at module level in a test → throws `/outside a request scope/` (or core's own no-resolver text; record which).
- [ ] **Step 3: Implementation** (`core-adapter.ts`):
```ts
import { __setServerResolver } from '@brust/runtime-dom/store'
/** Installs `resolver` as core's server-side instance lookup (design §2.1). Called once at worker boot. */
export function installServerResolver(resolver: ServerResolver): void {
  __setServerResolver(resolver as Parameters<typeof __setServerResolver>[0])
}
```
  - `worker.ts` top level, after the imports: `installServerResolver(getServerInstance)`.
  - If core's names or shapes differ (export path, record fields, `handle.hydrate`), fix ONLY `core-adapter.ts` and note the delta on the task. If the fix needs more than the adapter, file a `task challenge` naming the field.
  - `grep -rn "@brust/runtime-dom\|@brust/core/store" packages/brust/src --include=*.ts | grep -v core-adapter.ts` → only `build/bundle.ts` specifier strings.
- [ ] **Step 4:** Run the gates, including `packages/runtime-dom` typecheck/test. Commit `feat(core): register the server store resolver at worker boot (M3-F, core adapter)`.

### Task S9: End-to-end, CI wiring, perf sanity, READY

**Files:** Create `packages/brust/test/e2e-store.test.ts` and `packages/brust/test/fixtures/store-app/`. Modify `.github/workflows/ci.yml` (:120-124).

- [ ] **Step 1: Fixture** `store-app`:
  - `stores/cart.ts` (`defineStore('cart', () => ({ count: signal(0) }))`) and `stores/user.ts` (`defineStore('user', …)`);
  - `/` static (no loader);
  - `/cart` native component (useState button) with a loader `cart.count.set(3); return { x: 1 }`, route `cache: { ttl_seconds: 60 }`;
  - `/plain` native, loader touching no store;
  - `/both` loader writing both stores;
  - `/island` react island with an ssr job, loader `cart.count.set(6)`.
- [ ] **Step 2: Test** (copy the boot/stop harness of `e2e.test.ts:17-58`, `--workers 2`):
  - `/cart`: exactly one `data-brust-store="cart"` tag `{"count":3}`, at `html.indexOf(tag) + tag.length === html.indexOf('<script type="module" src="/_brust/client/runtime-')`; a second GET returns `x-brust-cache: HIT` and an identical body;
  - `/both`: tags `cart` then `user`;
  - `/plain` and `/`: no `data-brust-store`;
  - `/island`: the ssr job ran (island host non-empty) and `/_brust/cache/stats` `job_calls` grows on a store change. The loader reads `req.search.n` into the count: `?n=6` twice → one job call, `?n=7` → another;
  - `stats().loader_calls` arithmetic as in `e2e.test.ts`.
- [ ] **Step 3: CI.** Append `test/store-server-context.test.ts test/worker-store.test.ts` to the `:120` list. Add lines `- run: cd packages/brust && bun test test/build-store.test.ts` and `- run: cd packages/brust && bun test --timeout 120000 test/e2e-store.test.ts` after `:124`. Docs-free.
- [ ] **Step 4: Perf sanity** (catches Risk L2 before the dogfood lane's §5.5 gate):
  - Copy `abproto.ts` per `docs/plans/2026-10-11-m3p-e-tail.md` §Measurement into `$OUT`.
  - Build `before.node` at the lane base and `after.node` at HEAD (`bun run build`, release).
  - Run `BENCH_LOCK_WS=<ws> BENCH_LOCK_ID='m3f-store-server <agent>' AB_VARIANTS=before,after AB_PROBES=I,D,S AB_ROUNDS=3 bun $OUT/abproto.ts` (it also swaps the worker TS from the scratch clone of each side; confirm both sides' `worker.ts` differ).
  - Acceptance: median paired rps ≥ −1% on D, I and S. Below that, STOP and post the numbers (Risk L2 has the ruling options). Do not optimise silently.
- [ ] **Step 5:** All gates, `IDENTICAL` ×4, then READY:
```
READY lane/m3f-store-server @ <sha> (base m3f @ <sha>, core merged @ <sha>)
rulings applied: R1 … R6 (as ruled)
rust: protocol store (Ok/NotFound), ctx __store (declined+planned), ssr inputs __store, data-brust-store before runtime
ts: server-context (ALS, seed-on-create, touch), core-adapter (installServerResolver: <core API delta or "none">), worker scope, bundle alias + regex + jobs stores
tests: tests/store.rs <n> · tests/render.rs +<n> · store-server-context <n> · worker-store <n> · build-store <n> · e2e-store <n> (alone ×3)
byte-identical: IDENTICAL ×4 after S2/S3/S4/S6/S7/S9; data-brust-store in no-store bodies: 0; pokedex/bench jobs.js sha unchanged
job keys: job_keys_are_pinned + pokedex_plans_match_the_golden unchanged
perf A/B (3 rounds, paired median): D …% I …% S …% (CPU µs/req … → …) loads …
attribution.patch: applies / does not apply at render_document (not regenerated)
gates: <paste>
```

### Task S10: Post-compiler-merge verification (on `m3f`)

- [ ] After `m3f-store-compiler` merges: `cd ~/code/brust-m3f && git pull --ff-only && bun install --frozen-lockfile && cd packages/brust && bun run build:debug` (fresh addon: the compiler and server crates both changed).
- [ ] Rerun `snap.sh`/`cmp.sh` against the S1 `before` → `IDENTICAL` ×4.
- [ ] Add to `fixtures/store-app` one native component that renders `const s = useStore(cart); <b id="n">{s.count}</b>`. `e2e-store.test.ts` asserts:
  - first paint `<b id="n">3</b>` on `/cart`;
  - its manifest component record has `stores: ['stores/cart.ts']`;
  - a page whose loader does NOT write the store still gets the `cart` tag with defaults (touched via the manifest union).
- [ ] Commit on a short lane `lane/m3f-store-server-verify` from `m3f`, and post a task note. The lead merges.

## Risk ledger

| # | risk | where | mitigation / stop rule |
|---|---|---|---|
| L1 | A field handled only in `page()` is lost on routes with jobs (planned path) | `pipeline.rs:1721-1760` vs `:384-405` | One `merge_loader_response` for all three sites. `planned_and_declined_paths_render_the_same_bytes` (Review Focus 6) |
| L2 | `AsyncLocalStorage.run` per loader call costs CPU on D/I/S, where no page touches a store | `worker.ts` loader | S9 A/B. If < −1%, STOP. Lead options: (a) accept and record it in `bench/ATTRIBUTION.md`; (b) enter the scope only when the route's union is non-empty or a loader module imports a store (needs a build-time flag per route: a new manifest field, i.e. a contract change); (c) a cheaper scope primitive. Never drop the scope silently: a loader touching a store would then throw |
| L3 | `__store: null` always in ssr inputs would change every ssr job key and the plan golden on no-store pages | C5 wording | R1. Tests: `job_keys_are_pinned`, `pokedex_plans_match_the_golden` unchanged |
| L4 | Island or native chunk bundles its own copy of the core, so two signal graphs exist on one page | `bundle.ts:217-276` | `runtimeAliasPlugin` in both builds; `build-store.test.ts` asserts a single core file. The `useStore` bridge's relative imports go to the runtime, so EXPECTED of core: `store/react.ts` imports only names the runtime bundle re-exports (`export * from '@brust/runtime-dom'`), ideally via the bare `@brust/runtime-dom` specifier. A runtime "does not provide an export named X" at island load means the expectation broke: task challenge to core |
| L5 | SSR loads a second, resolver-less store core | `jobs.js` | F6: `@brust/core/*` is external. `@brust/runtime-dom/store*` is aliased to `@brust/core/store*` (S6). A component importing `defineStore` from the bare `@brust/runtime-dom` root still bundles a copy. The documented import is `@brust/core/store`. If dogfood hits this, ask core to keep the resolver on `globalThis` (C7-style); that is a contract addition, so lead ruling |
| L6 | Store module code runs twice in the worker (`jobs.js` copy + the loaders' source copy) | R2 | Records are per name per scope, so state is shared. Module side effects run twice: documented for the store docs page (dogfood lane) |
| L7 | Escaping drift between Rust and 0.1.x (`toScriptJson`) | `render.rs` | Same 5 characters, same `\uXXXX` forms; `store_json_is_script_safe` table. JSON key order differs (Rust: sorted; 0.1.x: insertion); the client parses it, so the order is not observable |
| L8 | `bench/attribution.patch` stops applying (it instruments `render_document`) | `pipeline.rs:706` | `git apply --check` in S4; report, do not regenerate (M3-P artifact; the dogfood lane's bench owner decides) |
| L9 | A stale `.node` after a Rust change or after the compiler merge makes green tests lie | napi addon | `bun run build:debug` after every Rust edit and at S8/S10 (Global) |
| L10 | Port flakes when server-starting test files run together | `e2e*.test.ts`, `napi-server.test.ts` | Run alone; CI lines are separate (S9 Step 3) |
| L11 | Compiler lane's `stores` paths are not relative to `appRoot` or not normalised | C3 | `buildJobs` rejects absolute and `..` paths and missing files (`store-module`); S10 verifies the real output. A mismatch is a task challenge to the compiler lane, not a guess |
| L12 | Core's API names or record shape differ from the expectations in `core-adapter.ts` | S8 | All core names live in `core-adapter.ts` (`__setServerResolver`, `StoreRecord.handle.{serialize,hydrate}`, C8 duck type). Fix there; if more than the adapter must change, task challenge |
