# cache-cloudflare: `@brust/cache-cloudflare`, the built-in Cloudflare KV store and Durable Object broadcast/store adapters (`/kv`, `/do`, `combine`), the `BrustCacheDO` export via a generated `worker/main.js`, and build-time binding verification
**RULED by lead Detoro 2026-10-12 (before dispatch): R1-R15 ALL ACCEPTED as their defaults — R1 the generated entry re-exports `BrustCacheDO` and `worker/main.js` re-exports it from `./brust-app.js` (one module copy); smoke-preload gains the `DurableObject` stub (Task 8); R2 `adapter = "cloudflare-kv"` + `broadcast = "cloudflare-do"` routed through a 3-line `composeWith` hook in lane A's composer (boundary includes that file); R3 binding names = the RULED SPEC's `BRUST_CACHE` (KV) and `BRUST_CACHE_DO` (DO) — the brief's `BRUST_KV`/`BRUST_EPOCH` are withdrawn; R4 meta inside the KV value (Redis framing), no KV metadata, min `expirationTtl` 60 s, brust's `kv_min_ttl_s` stays 300; R5 a conformance skip flag `invalidate` for KV-alone (documented: KV alone never invalidates); R6 `combine` keeps per-name invalidation markers in JS loaded from the DO on first contact/reset (closes the fresh-isolate gap); R7 the DO persists `seq` + per-name markers in its SQLite storage (ring stays in memory; restart still clears isolates once) — this is the adapter's own state, inside the user's opted-in DO, consistent with the Workers-only runtime rule; R8-R10 16 shards, 1.9 MB row cap, publish under waitUntil, missing binding/class = build error printing the exact snippet (no auto-add); R11-R15 ✓ incl. Task 2 local-workerd capability checks first and the optional real deploy deleting the DO class explicitly per bb rule:cloudflare-account. Release lines (lockstep +1, publish after core) go to whichever of lane 6 / lane B merges later. Base: m4cf after lane A (and lane 6) merge. Implementer knock2, reviewer Mellow. Worktree via `conclave lane start` FROM /Users/detoro/code/brust.**
owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · base: m4cf after lane A `cache-adapter-core` AND lane 6 `m4cf-ci` merge · lane: cache-cloudflare · tier: standard · review: complex
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

This is lane C of the ruled spec `docs/design/2026-10-12-cache-adapter-design.md`. Read §3.1, §4.2, §4.3, §5.2, §5.3, §6, §7 and §9 before Task 2.
It builds ONLY on what lane A exports. Its contract is lane A's ruled plan `docs/plans/2026-10-12-cache-adapter-core.md` (R1-R16, L1-L6).
Implementer: knock2 (after lane 6). Reviewer: Mellow.

Grounding: m4cf @**c019969**, worktree `/Users/detoro/code/brust/.claude/worktrees/m4cf`. At that commit lane A is ruled but NOT merged, and lane 6 is NOT merged.
Markers:
- `[A]` = a lane-A name taken from its ruled plan. Task 1 re-verifies each one against the merged code and challenges on a mismatch.
- `[6]` = a lane-6 fact from `docs/plans/2026-10-12-m4cf-ci.md`.
- `[C]` = a Cloudflare doc fetched 2026-10-12.
- `[I]` = an inference a task proves.

## Facts the plan rests on

**Lane A contract [A]**
- `@brust/core/cache-adapter` exports the §3.1 types plus:
  - `GetResult { page, stamp, entryStamp, storedAt }`;
  - `SetMeta { ttlMs, tags, method, path, stamp: number | null }`;
  - `EpochSince { gen, seq, behind, events }`, `InvalidationEvent { seq, origin, args }`;
  - `CacheAdapter { name, runtimes, store?, broadcast?, init?, close? }`, `defineCacheAdapter`, `memoryAdapter`.
- `@brust/core/cache-adapter/conformance` exports `runConformance(make, caps: { push?, pull?, guard? })` (bun:test). Its cases include a `ttlMs: 1` expiry, tag and path invalidation, the stale-stamp refusal (`guard`), `maxBodyBytes`, "`get().stamp` equals the last publish seq", and pull contiguity / `behind` after overflow.
- Built-in contract (lane A R8):
  - `adapter = "cloudflare-kv"` → the default export of `@brust/cache-cloudflare/kv`; `"cloudflare-do"` → `@brust/cache-cloudflare/do`. Each is a `CacheAdapterFactory` called with the `[cache.cloudflare]` table.
  - Resolution: `Bun.resolveSync(spec, appRoot)`, with an install hint when missing.
  - `broadcast = "<built-in>"` composes `{ ...adapter, broadcast: other.broadcast }`.
  - An `env:` value is a BuildError on `--target cloudflare`.
- Workers wiring:
  - The generated entry passes the adapter to `install(rt, ext)` with `waitUntil` from `cloudflare:workers` (lane A R11).
  - `afterInvalidate` runs `Promise.allSettled([store?.invalidate(args), broadcast?.publish(args, origin)])` under `waitUntil` (lane A Task 7).
  - The Rust cursor (`crates/brust-wasm/src/epoch/`) polls `since` at most once per `epoch_interval_ms`, single-flight, 500 ms cap. It keeps the invalidation floor: an LRU of 4096 names; a HIT whose `entryStamp` is below a tag/path floor is a miss; `entryStamp: null` is never rejected. On first contact it adopts without replay.
  - Write-through happens on any `Miss{stamp}`; `stamp: null` = an unguarded write (L2). A replay never re-publishes (L3).
  - The CF smoke check calls `install(fakeRt)` when `CONFIG.cache` is set (R14). `CONFIG` abi stays 1 (R13).
- Lane A's fixture `tests/fixtures/cf-l2` + `tests/cf/cache-adapter.test.ts` are the Workers e2e this lane re-runs with the DO.

**CF build today** (`packages/brust/src/build/cloudflare.ts`)
- The smoke preload stubs `cloudflare:workers` as `{ env: {}, waitUntil() {} }` (:154). It has no `DurableObject` export, so a bundle that defines `class … extends DurableObject` fails the smoke at import.
- CONFIG :189-198; the entry is written :199-204; the bundle :217-226 (`external: ['node:*','cloudflare:*', glueSpec]`, `conditions ['workerd','worker','browser']`, `cfGuard` :84-95 rejects `bun`/`bun:*`).
- `brust-app.js` goes to `worker/<appModuleDir>/` (:232-234); `mergeWrangler(…, { main: p.core.meta.main })` :240; `wrangler.jsonc` written :242; the smoke spawn :247-253 (its hint: "open bindings lazily").

**Wrangler merge** (`cf-wrangler.ts`)
- `OWNED` :25 includes `main`. `mergeWrangler` :78-113 sets `main: \`worker/${o.main}\`` (:107) and copies every other user key: `kv_namespaces`, `durable_objects`, `migrations`, `exports`, `env`. `assertNoAssetsBinding` :53-62.

**Entry** (`cf-entry.ts`)
- `cfEntrySource` :25-47; `export { install } …` :44 (lane A replaces it when `[cache]` is set). The D3 snapshot `tests/cf/entry.test.ts` must stay byte-identical without `[cache]`.

**Glue**
- `npm/core-cf/package.json`: `brust.main = brust.glue = "index.js"`, `appModuleDir "."` (read by `cf-core.ts:50-56`).
- `worker/index.js` imports `./brust-app.js` and exports exactly `{ ContainerStartupOptions, MinifyConfig, R2Range, default }`.
- worker-build's own `worker/shim.mjs` is `export * from '../index.js'; export { default } from '../index.js';`, the pattern R1 copies. A JS DO class cannot be bound today (spec §5.3).

**Local tooling**
- `tests/cf/tools.ts:2` `WRANGLER = 'wrangler@4.149.0'` (`bunx`, never a lockfile dependency).
- `tests/cf/pokedex-d1/remote.ts`: `freePort` :11-19; `startWrangler({config,state})` :34-65 (`--persist-to`, waits for `Ready on`, SIGINT then SIGKILL).
- The harness-Worker pattern is `tests/cf/pokedex-d1/{harness.ts,wrangler.jsonc}`: wrangler bundles a TS Worker, and Bun drives it over HTTP.
- The real-deploy pattern is `tests/cf/pokedex-d1-edge.ts`: name `brust-test-<slug>-<sha>` (:13), wrangler output captured and never echoed (:18-22), delete in `finally` + post-delete probes (:77-91).
- `tests/fixtures/cf-min/scripts/build-cf.ts` honours `BRUST_CF_WASM_READY`. The CLI takes `--out-dir` (`cli.ts:10,48`).

**Types precedent**
- `examples/pokedex/lib/cloudflare.d.ts` declares the D1 subset and `declare module 'cloudflare:workers'` ambiently, "so `bun check` needs no @cloudflare/workers-types (whose global Request/Response clash with lib DOM)". `bun.lock` has no `@cloudflare/workers-types`.

**Workspace and CI**
- Root `package.json` `workspaces` has `packages/*` (a new `packages/cache-cloudflare` joins automatically) and lists `tests/fixtures/cf-min` explicitly.
- `ci.yml:89` runs `BRUST_CF_E2E=1 bun test --timeout 900000 tests/cf`, so new `tests/cf/*.test.ts` files need no ci edit. Lane 6 may move the line: re-locate it in Task 1.

**Release (lane 6 owns) [6]**
- After lane 6: `scripts/release-files.ts` `FILES` has 10 entries (`:3` has 9 today); `release-check.ts` prints `✓ 10/10`; `release.yml` publishes runtime-dom → 6 natives (PLATS loop) → core-cf → core → create-app.
- Today's lines: the dry-run loop `release.yml:68`; the `pub` lines :126-129; the dist-tag list :130. The version is `2.0.0-alpha.2` (`packages/brust/package.json`).

**Pokedex**
- `examples/pokedex/brust.toml` (12 lines, no `[cache]`); `examples/pokedex/wrangler.jsonc` (5 lines, D1 only).
- `packages/create-app/templates/pokedex` is generated by `scripts/sync-template.ts` as a byte copy (`sync-template.test.ts:18-24`), so comment edits flow through.

**Cloudflare facts [C]**
- KV: key 512 B; value 25 MiB; **metadata 1024 bytes** (serialized JSON); 1 write/s per key (429 beyond); min `cacheTtl` 30 s; **min `expirationTtl` 60**; propagation "up to 60 seconds"; 1,000 KV operations per invocation.
  - Free per day: 100,000 reads, 1,000 writes, 1,000 deletes, 1,000 lists; 1 GB stored.
  - Paid: 10 M reads and 1 M writes/deletes/lists per month, then $0.50 / $5.00 per million.
- Durable Objects: SQLite string/BLOB/row ≤ **2 MB**; SQL statement ≤ 100 KB; soft limit 1,000 req/s per object; Free: 100 classes per account, 5 GB stored.
  - Free per day: **100,000 requests**, 13,000 GB-s, 5 M rows read, 100,000 rows written.
  - Paid: 1 M requests/month then $0.15/M; 50 M rows written/month then $1.00/M.
  - "Every RPC method call on a Durable Objects stub is … a single billed request". Past a Free limit, "further operations of that type will fail with an error".
  - `getByName(name, { locationHint? })` exists on the namespace.
- Migrations: `{ "tag", "new_sqlite_classes": [...] }`; "Durable Object entries in `exports` are mutually exclusive with `migrations`"; "Deleting a class removes its namespace and all of its stored data permanently".
- Workers: subrequests per invocation **50 Free / 10,000 Paid** (KV counts; DO is not named, so assume it counts); `waitUntil` runs ≤ 30 s after the response.
- Wrangler: `wrangler delete` "Delete your Worker and all associated … resources" (DOs not named, so R13 deletes the class explicitly). `wrangler kv namespace create <NAME>`; `wrangler kv namespace delete --namespace-id <id> --skip-confirmation`.

## Goal
- `packages/cache-cloudflare` publishes `@brust/cache-cloudflare`: lockstep version, `runtimes: ['workers']`, no `bun`/`bun:*` import, peer `@brust/core`. Subpaths:
  - `/kv`: default export = factory; named `kvAdapter`;
  - `/do`: default export = factory; named `doAdapter`, `BrustCacheDO`;
  - `.`: `combine`, `kvAdapter`, `doAdapter`, `BrustCacheDO`, option types.
- `kvAdapter({ binding = 'BRUST_CACHE', min_ttl_s = 300 })` is a store only, with no broadcast. Bodies and meta live in KV under lane A's `L2Key`. `set` refuses `ttlMs < min_ttl_s * 1000` (→ `false`, counted as `set_refused`). Expiry is enforced on read. `invalidate` is documented best-effort (R5).
- `doAdapter({ binding = 'BRUST_CACHE_DO', store = false })` is a pull broadcast (`since`, `publish`) backed by ONE `BrustCacheDO` epoch instance per namespace: a ring of 1024 events / 1 MiB with `gen` + `seq`; behind or a gen change makes the Rust cursor clear. With `store: true` it is also an exact-guarded body store sharded over 16 `BrustCacheDO` instances (rows ≤ 2 MB).
- `combine(kv, do)` = the KV store + the DO broadcast, with correct floors (R6). `[cache] adapter = "cloudflare-kv"` + `broadcast = "cloudflare-do"` yields exactly `combine` (R2).
- `brust build --target cloudflare` with a DO configured writes `dist/cf/worker/main.js` (3 lines, R1), points wrangler `main` at it, and re-exports `BrustCacheDO` from `brust-app.js`.
- With `[cache]` naming a Cloudflare built-in, the build verifies the user's wrangler config (top level and every `env.*`). A missing binding or class declaration fails with the exact `kv_namespaces` / `durable_objects` + `migrations` snippet; nothing is auto-added (spec R11).
- Without `[cache]`, every build output and the D3 snapshot are byte-identical to the base.
- Lane A's conformance suite is green under local workerd for `kv`, `do` (store) and `combine`. `tests/cf/cache-cloudflare.test.ts` re-runs lane A's Workers e2e with the DO broadcast (KV-store and DO-store variants) and adds gen-change and new-isolate-floor cases.
- The pokedex carries a commented `[cache]` block and a commented `wrangler.jsonc` snippet. Release packaging lines are handed to lane 6's owner (Reporting).

### Options (`[cache.cloudflare]`, spec §6 keys; R3)
| key | used by | default | range / rule |
|---|---|---|---|
| `kv_binding` | `/kv`, `combine` | `"BRUST_CACHE"` | a binding name in `kv_namespaces` (R10) |
| `kv_min_ttl_s` | `/kv`, `combine` | `300` | `0..=31536000`; a route with a smaller ttl is not written |
| `do_binding` | `/do`, `combine` | `"BRUST_CACHE_DO"` | a `durable_objects` binding with `class_name "BrustCacheDO"` (R10) |
| `do_store` | `/do` | `false` | `true` = bodies in 16 DO shards (ignored under `combine`) |

### Semantics per configuration (the README table; lane D copies it)
| config | store | other isolates after `cache.invalidate` | stale body re-served? | Free-plan cost driver |
|---|---|---|---|---|
| `cloudflare-kv` alone | KV, unguarded | ≤ ttl (no broadcast) | yes, ≤ ttl (≥ 300 s) | 1 KV write per MISS |
| `cloudflare-do` (`do_store=false`) | none (tier 1 only) | ≤ `epoch_interval_ms` + RTT | no | 1 DO req / poll / isolate |
| `cloudflare-do` (`do_store=true`) | DO shards, exact guard | ≤ interval + RTT | no (rows deleted on publish) | + 1 DO req per L1 miss, + 17 per invalidation |
| `kv` + `broadcast = "cloudflare-do"` | KV, floor-guarded (R6) | ≤ interval + RTT | no once the floor is known; KV lag hidden by `entryStamp` | KV write per MISS + DO polls |

## Rulings requested
**R1 — How `BrustCacheDO` reaches the deployed main module.** *Default:* when a DO is configured (the R2 trigger):
- the generated entry gains ONE line, `export { BrustCacheDO } from "@brust/cache-cloudflare/do"`;
- the build writes `dist/cf/worker/main.js`: a `// generated by brust build --target cloudflare (do not edit)` header, then `export * from "./index.js"`, `export { default } from "./index.js"`, `export { BrustCacheDO } from "./<appModuleDir>/brust-app.js"`;
- `mergeWrangler` gets `main: 'main.js'`.

This keeps one module instance (the glue already imports `./brust-app.js`) and adds no second bundle. The build refuses if core-cf ever ships its own `worker/main.js`. *Alternatives:* (a) the spec §5.3 text: a separate `brust-cache-do.js` bundle (duplicates the adapter code, two module instances); (b) the user writes the re-export (impossible today: `main` is brust-owned, `OWNED` :25); (c) a Rust `#[durable_object]` in brust-wasm (splits the adapter across languages, and the runtime would ship a DO, against spec R1).

**R2 — `combine` config spelling and the DO trigger.** *Default:* `adapter = "cloudflare-kv"` + `broadcast = "cloudflare-do"` (spec §6, no new names).
- Lane A's composer gains a 3-line generic hook: if the broadcast adapter has `composeWith(storeAdapter)`, its result replaces the spread. `doAdapter` implements it as `combine(store, this)`.
- "DO configured" = `adapter` or `broadcast` is `cloudflare-do`, OR `[cache.cloudflare].do_binding` is written explicitly (for `custom` modules that call `doAdapter`/`combine` themselves).

*Alternatives:* (a) a new built-in name `cloudflare-kv+do` → subpath `/kv-do` (touches lane A's name list and error text); (b) reject the pair and require `adapter = "custom"` with `combine` (the naive spread silently loses R6's floors, so it must not stay reachable).

**R3 — Binding names and option keys.** *Default:* the spec §6 names and keys in the Options table above. One DO class and one binding serve both roles (epoch and shards). Programmatic forms are `kvAdapter({ binding?, min_ttl_s? })` and `doAdapter({ binding?, store? })`; an unknown key → `TypeError` naming the key (it surfaces at the build smoke). There is no `namespace` option: lane A's `init({ namespace, buildId })` supplies it, and L2Keys already carry it. *Alternative:* the task-prompt names `BRUST_KV` / `BRUST_EPOCH` (they diverge from the ruled spec and from lane A's docs).

**R4 — KV value format.** *Default:* ONE format, no KV metadata (no 1024-byte cliff; headers + tags easily exceed it):
- value = `[u32 LE meta_len][meta JSON {v:1,status,headers,tags,method,path,entryStamp,storedAt,expiresAt}][body]` (the Redis framing of spec §5.1);
- `put(key, frame, { expirationTtl: max(60, ceil(ttlMs/1000)) })`; `get(key, { type: 'arrayBuffer', cacheTtl: 60 })`;
- an isolate-local memo (1024 keys) skips a `put` of a key this isolate wrote < 60 s ago (the 1 write/s/key limit, and re-MISS storms behind `cacheTtl`); a 429 → `false`.

*Alternative:* the spec/task text: meta in KV metadata, and entries whose meta JSON exceeds 1024 B are not stored.

**R5 — KV invalidation scope.** *Default:* `kv.store.invalidate` deletes nothing. An L2Key hashes prefix + method + path + query, so a tag or path cannot be enumerated without index writes.
- KV alone = "stale ≤ ttl, ttl ≥ 300 s" (documented); correct invalidation needs the DO partner (R6).
- Lane A's `runConformance` gains ONE cap, `invalidate?: boolean` (default true; a 2-line skip in lane A's file), so KV alone runs with `{ guard: false, invalidate: false }`.

*Alternative:* spec §5.2 marker keys `…:t:<tag>:<h>` and `…:q:<method path>:<h>` + `list`/`delete`. That costs 1 + tags + 1 writes per set, is eventually consistent (≤ 60 s), and burns the Free 1,000 writes/day about 3× faster.

**R6 — KV + DO correctness (floors in JS).** *Default:* the Rust floor alone is insufficient. An isolate that first-contacts the DO adopts without replay, so it has no floors and would serve a KV body invalidated before it started, for up to ttl. `combine` therefore:
- (a) returns `stamp = lastSeq` from `get` (the highest seq this isolate saw via `since`/`publish`; `null` before the first poll);
- (b) refuses a `set` whose stamp is `null` or below a known floor of its tags/path;
- (c) keeps a JS floor map, seeded by a `floors()` RPC on first contact and after every gen change / behind (`{ gen, seq, names: [[name, seq]…] ≤ 4096, evicted }`) and raised by every replayed event and own publish;
- (d) answers a KV hit whose `entryStamp` is below the floor (or below `evicted` for an unknown name) as a miss;
- (e) on `combine.store.invalidate(args)`, raises the local floors of its names to `lastSeq + 1` at once (the matching publish then returns the real seq).

*Alternative:* rely on the Rust floor only and document "new isolates may serve an invalidated KV body ≤ ttl".

**R7 — DO epoch persistence.** *Default:* `seq` and the name→seq floor table (LRU 4096 rows + the `evicted` max) persist in the DO's SQLite (`meta`, `inval` tables).
- Cost: ≈ 2-5 rows written per publish, so the Free 100k rows/day ≈ 20k invalidations/day.
- The ring stays in memory, and `gen` is new on every construction, so isolates clear once after a DO restart (the spec rule is kept).
- Seqs never regress, so KV `entryStamp`s and DO-store guards stay comparable across restarts. With a memory-only seq, a restart would make every shard refuse all writes (old `inval` seqs) and would let old KV entries pass new low floors.

*Alternative:* memory-only per the spec, with `seq` seeded at `Date.now() * 1000` on construction (monotone across restarts without writes; < 2^53 until ~2255). Floors are then lost on restart, so `combine` sets a global floor = the new gen's first seq, and KV goes cold after every DO eviction (which happens on idle).

**R8 — DO store sharding.** *Default:* 16 shards.
- Shard name `getByName("store:<namespace>:<i>")` with `i = parseInt(key.at(-1), 16)` (the L2Key ends in blake3 hex).
- Tables `pages(key PK, meta TEXT, body BLOB, mpath TEXT, expires_at INT)`, `tags(tag, key)`, `inval(name PK, seq)`. An alarm sweeps expired rows every 60 s while rows exist.
- `store.maxBodyBytes = min(lane A's max_body_bytes, 1_900_000)` (row ≤ 2 MB including meta).
- An invalidation = 1 epoch `publish` RPC, then 16 shard `invalidate(args, seq)` RPCs = 17 subrequests (Free cap 50), issued by the Worker under `waitUntil`.
- `store.invalidate` and `broadcast.publish` share one memo per `args` object, so exactly ONE epoch publish happens whichever lane A calls first (or when only one is called).

*Alternatives:* 4 or 64 shards; the epoch DO fans out to the shards itself (1 Worker subrequest, but a slower single-threaded DO).

**R9 — Does `publish` await the DO?** *Default:* no. It runs under lane A's `waitUntil` (R11), so the action response is not delayed. One retry after 250 ms; a failure → lane A's `publish_errors`, and other isolates stay stale ≤ ttl. *Alternative:* await before the action responds (+1 DO round trip per mutation, possibly cross-continent: DOs never move [C]).

**R10 — Binding verification strictness.** *Default:* a BuildError `cf-config` (no auto-add) when, at top level or in any `env.<name>` block:
- the KV store is configured and `kv_namespaces` lacks `{ binding: kv_binding }`;
- a DO is configured and `durable_objects.bindings` lacks `{ name: do_binding, class_name: "BrustCacheDO" }` without `script_name`;
- `BrustCacheDO` is declared neither by a `migrations[].new_sqlite_classes` entry nor by `exports.BrustCacheDO = { type: "durable-object", storage: "sqlite" }`;
- or it is declared via `new_classes` (KV-backed: no SQL API).

The message prints the exact JSONC snippet (Task 8). *Alternative:* a warning, with the adapter failing open at runtime (L2 silently off).

**R11 — Cloudflare types.** *Default:* an ambient `src/cloudflare.d.ts` in the package: the KV/DO/SQL subset used, plus `declare module 'cloudflare:workers' { env; DurableObject }`. This is the repo precedent (`examples/pokedex/lib/cloudflare.d.ts`). *Alternative:* `@cloudflare/workers-types` as a devDependency per spec §7 (its DOM `Request`/`Response` clash under `bun check`).

**R12 — DO test hooks.** *Default:* `BrustCacheDO` exposes `__regen()`, `__failNext()` and `__state()` RPCs only when `env.BRUST_CACHE_TEST === "1"`. That var is set in the test wrangler configs only; elsewhere the hooks throw. *Alternative:* a test-only subclass exported from a `/testing` subpath (it needs its own class declaration in the test configs).

**R13 — Real deploy (optional last task).** *Default:* ONE deploy named `brust-test-cache-cloudflare-<shortsha>` (KV namespace + Worker + DO class), a worst-staleness measurement, then in `finally`:
1. deploy a tombstone version: `migrations` + `{ tag: "brust-cache-delete", deleted_classes: ["BrustCacheDO"] }`, the DO binding removed, `main` without the re-export;
2. `wrangler delete --name N --force`;
3. `wrangler kv namespace delete --namespace-id <id> --skip-confirmation`;
4. probe each one and expect non-zero (not found).

No ids or URLs in any output, note or file. *Alternative:* skip the real deploy; local workerd proves everything except cross-colo staleness.

**R14 — Free-plan guidance for lane D.** *Default:* this lane writes the numbers into `packages/cache-cloudflare/README.md` only (the table below); lane D copies it into the docs. *Alternative:* no numbers outside `docs/`.

| driver | per day | Free quota [C] | note |
|---|---|---|---|
| epoch polls, 1 busy isolate, `epoch_interval_ms` 1000 | 86,400 DO req | 100,000 DO req | 86 % for ONE isolate |
| same at 5000 ms | 17,280 | 100,000 | ≈ 5 busy isolates |
| same at 60000 ms | 1,440 | 100,000 | ≈ 69 isolates; staleness ≈ 60 s |
| `do_store` L1 miss | 1 DO req each | 100,000 | plus rows read |
| invalidation | 1 DO req (17 with `do_store`) + ≤ 5 rows written | 100,000 rows written | |
| KV write-through | 1 KV write per MISS of a ttl ≥ 300 s page | 1,000 writes | the binding constraint on Free |
| KV read-through | 1 KV read per L1 miss | 100,000 reads | |

Advice line: on Free, set `epoch_interval_ms ≥ 5000` and prefer KV + DO over `do_store`.

**R15 — Local workerd scope.** *Default:* Task 2 spikes, under the pinned wrangler with `wrangler dev --persist-to`: SQLite DOs via `migrations`, `getByName`, RPC with `Uint8Array` arguments, KV `put`/`get`/`delete`, and the R1 `main.js` re-export. Any failure is a challenge; this lane carries no fallback design. *Alternative:* drive Miniflare's API directly (a new dependency).

## Boundary
- `packages/cache-cloudflare/**` (new).
- Root `package.json` (`workspaces` + `tests/fixtures/cf-cache`); `bun.lock` (the two new members only).
- `packages/brust/src/build/{cloudflare.ts, cf-wrangler.ts, cf-entry.ts}`.
- `packages/brust/test/cf-cache-bindings.test.ts` (new); `packages/brust/test/{cf-entry,cf-build}.test.ts` (added cases only).
- Lane A files, minimal: the composer site(s) (R2, ≤ 5 lines) and `packages/brust/src/cache-adapter/conformance.ts` (the R5 cap, ≤ 3 lines).
- `tests/cf/cache-cloudflare/**` (harness Worker, configs, proxy), `tests/cf/cache-cloudflare-conformance.test.ts`, `tests/cf/cache-cloudflare.test.ts`, `tests/cf/cache-cloudflare-edge.ts` (R13), `tests/fixtures/cf-cache/**` (new).
- `examples/pokedex/{brust.toml, wrangler.jsonc}` (comments only); `.github/workflows/ci.yml` (one unit-test line in the `cf` job).
- NOT: `crates/**`, `npm/core-cf/**`, `release.yml`, `scripts/release-*`, `packages/create-app/**`, `docs/**` (lane D). Anything else → `conclave task challenge`.

## Tasks
Variables: `W=/Users/detoro/code/brust/.claude/worktrees/lane-cache-cloudflare`, `OUT=/private/tmp/cache-cloudflare` (never committed), `WS=838f12fb-70c1-41b7-acf2-d4065cf6bb64`, `P=packages/cache-cloudflare`, `WR='bunx wrangler@4.149.0'`.
Commit per task with the Co-Authored-By trailer; never `git add -A`. Kill only the wrangler PIDs you spawned.

### Task 1 — worktree, base, baselines
- [ ] `conclave lane start` from `/Users/detoro/code/brust` (or `git -C /Users/detoro/code/brust fetch origin && git -C /Users/detoro/code/brust worktree add $W -b lane/cache-cloudflare origin/m4cf`), then `cd $W`.
- [ ] Prove both prerequisites:
  - `test -f packages/brust/src/cache-adapter/conformance.ts && echo A` → `A`;
  - `bun -e "console.log(require('./scripts/release-files.ts').FILES.length)"` → `10`.
  Either failing means the wrong base: challenge.
- [ ] `bun install --frozen-lockfile && (cd packages/brust && bun run build:debug)` → exit 0. `bun crates/brust-wasm/scripts/build.ts --e2e` → prints `wasm raw=…`.
- [ ] Re-verify every `[A]` fact: `rg -n "entryStamp|composeWith|broadcast:|runConformance|afterInvalidate|allSettled" packages/brust/src/cache-adapter packages/brust/src/server-handlers.ts packages/brust/src/build`. Record each composer file:line and the conformance case list in `$OUT/a-facts.txt`. A missing name → challenge.
- [ ] Baselines:
  - `mkdir -p $OUT && (cd packages/brust && bun test 2>&1 | tail -3)` → 0 fail;
  - `bun test tests/cf/entry.test.ts` → pass;
  - `BRUST_CF_WASM_READY=1 BRUST_CF_E2E=1 bun test --timeout 900000 tests/cf 2>&1 | tail -5 | tee $OUT/cf-before.txt` → 0 fail;
  - build cf-min once and keep `tests/fixtures/cf-min/dist/cf/{worker,wrangler.jsonc}` as `$OUT/cf-min-before/` (for A4).

### Task 2 — spike (R1, R15), throwaway in `$OUT/spike`
- [ ] Hand-write:
  - `$OUT/spike/index.js`: a default `fetch` with routes `/do/put`, `/do/get`, `/kv/put`, `/kv/get`, `/kv/del`;
  - `$OUT/spike/app.js`: `class Spike extends DurableObject` with SQL `CREATE TABLE IF NOT EXISTS t(k TEXT PRIMARY KEY, v BLOB)` and RPCs `put(k, u8)`, `get(k)`, `n()`;
  - `$OUT/spike/main.js`: the R1 three lines, re-exporting `Spike` from `./app.js`;
  - `wrangler.jsonc`: `main: "main.js"`, `kv_namespaces [{binding:"KV", id:"spike-local"}]`, a `SPIKE` DO binding, `migrations [{tag:"v1", new_sqlite_classes:["Spike"]}]`, `compatibility_date "2026-10-01"`.
- [ ] `$WR dev` with the `remote.ts` flag set and `--persist-to $OUT/spike/state`, then `curl` each route:
  - `env.SPIKE.getByName("a").put("k", new Uint8Array([0,255]))` then `get` → bytes `0,255`;
  - KV `put`/`get`/`delete` → the value, then null.
- [ ] `$WR deploy --dry-run -c $OUT/spike/wrangler.jsonc` → exit 0.
- [ ] Write `$OUT/spike.md` (each check ok/fail). Any failure → challenge with the log. No commit.

### Task 3 — package scaffold
- [ ] `$P/package.json`:
  - `name @brust/cache-cloudflare`; `version` = the `packages/brust/package.json` version; `type module`;
  - `exports { ".": "./src/index.ts", "./kv": "./src/kv.ts", "./do": "./src/do.ts" }`; `files ["src","README.md"]`;
  - `peerDependencies { "@brust/core": "workspace:*" }`; `devDependencies { "@brust/core": "workspace:*", "@types/bun": "^1.4.0", "typescript": "^7.0.2" }`;
  - scripts `test` (`bun test`) and `typecheck` (`bun check`); `publishConfig.access public`; license and repository as core.
- [ ] `tsconfig.json` copied from `packages/runtime-dom/tsconfig.json`. `src/cloudflare.d.ts` (R11). `README.md`: the Options and Semantics tables, the R14 table, the R5 KV caveat, the R10 snippet.
- [ ] Root `package.json` workspaces + `tests/fixtures/cf-cache` (add a stub `package.json` now; Task 10 fills the fixture). `bun install` → `git diff --stat bun.lock` shows only the two members.
- [ ] `(cd $P && bun run typecheck)` → 0; `rg -n "from ['\"]bun" $P/src` → empty. Commit `feat(cache-cloudflare): package scaffold`.

### Task 4 — pure modules (tests first)
- [ ] `src/frame.ts`: `encodeEntry(page, meta) → Uint8Array` and `decodeEntry(u8) → { page, meta } | null` (R4). Tests `test/frame.test.ts`:
  - all 256 byte values round-trip; header order + repeats kept;
  - a truncated frame → `null`; `meta_len` > length → `null`; `v !== 1` → `null`.
- [ ] `src/ring.ts`: `Ring(gen, startSeq, capEntries = 1024, capBytes = 1 << 20)` with `publish(args, origin) → seq` and `since(seq) → EpochSince`. Tests `test/ring.test.ts` (the epoch-draft list):
  - consecutive seqs from `startSeq + 1` (R7);
  - `since` returns only newer events; up to date → empty, not behind;
  - behind the ring: cap 4, publish 6, `since(1)` → behind, `since(2)` → seqs 3..6;
  - the bytes cap drops the oldest; an event > 64 KiB is stored as a clear marker, so anyone before it gets `behind`;
  - `since` ahead of `seq` → behind.
- [ ] `src/floors.ts`: `Floors(cap = 4096)` with `seed(snapshot)`, `raise(name, seq)`, `floorOf(tags, method, path) → number`, `evicted`. Names are `t:<tag>` and `p:<METHOD> <path>`; a path invalidation without a method covers GET and HEAD. Tests: `raise` keeps the max; LRU eviction raises `evicted`; an unknown name → `evicted`.
- [ ] `(cd $P && bun test test/frame.test.ts test/ring.test.ts test/floors.test.ts)` → green. Commit.

### Task 5 — `/kv` (R3, R4, R5)
- [ ] **Tests first** `test/kv.test.ts` with an in-memory `FakeKV` (`get(key,{type})`, `put(key,value,{expirationTtl})` recording the ttl, `delete`, `fail429Next`):
  - the factory reads `kv_binding` / `kv_min_ttl_s`; an unknown key → TypeError naming it;
  - constructing and `init` never touch `env` (a Proxy env that throws on any access);
  - `set` with `ttlMs 299_000` → `false`, no put; `300_000` → put with `expirationTtl 300`; `30_000` with `min_ttl_s 0` → `expirationTtl 60`;
  - `get` after `expiresAt` → `page: null`; a round trip keeps status, headers, body, `entryStamp`, `storedAt`; `stamp` is always `null`;
  - a second `set` of the same key within 60 s → no put, returns `true`; a 429 → `false`;
  - a missing binding at call time → rejects with `KV binding "BRUST_CACHE" is not bound (add it to wrangler.jsonc)`;
  - `invalidate` resolves with no KV call.
- [ ] Implement `src/kv.ts`: `import { env } from 'cloudflare:workers'`, the binding read per call; `name: 'cloudflare-kv'`, `runtimes: ['workers']`. Commit.

### Task 6 — `BrustCacheDO` + `/do` (R7, R8, R9, R12)
- [ ] `src/do-class.ts`, `export class BrustCacheDO extends DurableObject`:
  - constructor: `ctx.blockConcurrencyWhile` creates `meta`, `inval`, `pages`, `tags` (`CREATE TABLE IF NOT EXISTS`) and loads `seq`; `gen = crypto.randomUUID()`; `ring = new Ring(gen, seq)`;
  - epoch RPCs: `since(seq)`; `publish(args, origin) → { gen, seq }` (ring append, persist `seq`, upsert `inval` names, prune to 4096 rows raising `evicted`); `floors() → { gen, seq, names, evicted }`;
  - shard RPCs: `get(key) → Uint8Array | null` (expired → delete + null); `set(key, frame, meta, stamp) → boolean` (refuse when `stamp` is null or any `inval` name of its tags / `p:` path has seq > stamp; else upsert page + tags and arm the alarm); `invalidate(args, seq)` (upsert `inval`, delete matching pages/tags); `alarm()` sweep;
  - test hooks per R12.
- [ ] `src/do.ts`, `doAdapter({ binding, store })`:
  - `init` records the namespace; the epoch stub is `getByName("epoch:" + namespace)`;
  - `broadcast.since(seq)` → RPC, updating `lastSeq`;
  - `broadcast.publish(args, origin)` → the per-`args` memo (WeakMap) epoch publish with one retry; in store mode then 16 shard `invalidate(args, seq)` via `Promise.allSettled`;
  - with `store`: `get` → shard RPC → `decodeEntry` → `{ page, stamp: lastSeq, entryStamp, storedAt }`; `set` → shard `set(…, meta.stamp)`; `invalidate(args)` → the same memo (no second publish);
  - `composeWith(kv) = combine(kv, this)` (R2); the default export = a factory over `do_binding` / `do_store`.
- [ ] **Tests** `test/do.test.ts` with fake stubs (a `Map` of name → a plain object implementing the RPC surface over `Ring` / `Floors`):
  - the shard index for keys ending `0`..`f`;
  - ONE epoch publish when `store.invalidate` and `broadcast.publish` get the same args (either order), and when only one is called;
  - 16 shard invalidates in store mode, 0 without;
  - `lastSeq` follows `since` and `publish`; an unknown option → TypeError; nothing touches `env` before the first call.
  SQL paths are proven under workerd in Task 9. Commit.

### Task 7 — `combine` + the lane-A hook (R2, R5, R6)
- [ ] **Tests first** `test/combine.test.ts` (FakeKV + fake DO):
  - `get` before any poll → `stamp: null`; `set` with `stamp: null` → `false`;
  - the first `since` triggers exactly one `floors()`; a gen change re-seeds;
  - a KV entry with `entryStamp 5` for tag `x`, after a replayed event `{seq: 9, tags:['x']}` → `page: null`; the same for unrelated tag `y` → hit;
  - an unknown name with `evicted 7` and `entryStamp 5` → miss;
  - `store.invalidate({tags:['x']})` alone → the next get of an `x` entry misses, and `set(stamp = lastSeq)` for `x` → `false`;
  - `name === 'cloudflare-kv+do'`, `runtimes ['workers']`, `init` forwards to both.
- [ ] Implement `src/combine.ts`.
- [ ] Edit lane A's composer at each site in `$OUT/a-facts.txt`: `const composed = typeof other.composeWith === 'function' ? other.composeWith(adapter) : { ...adapter, broadcast: other.broadcast }`. Add the R5 `invalidate` cap to `conformance.ts`.
- [ ] Lane A's tests stay green: `(cd packages/brust && bun test test/cache-adapter-*.test.ts)`. Commit.

### Task 8 — build: entry line, `main.js`, binding verification, smoke stub (R1, R2, R10)
- [ ] **Tests first** `packages/brust/test/cf-cache-bindings.test.ts` on a pure `verifyCacheBindings(config, need) → { ok: true } | { ok: false; message }` exported from `cf-wrangler.ts` (`need = { kv?: string; do?: string }`):
  1. an empty config + `{kv:'BRUST_CACHE'}` → the message contains `"kv_namespaces": [{ "binding": "BRUST_CACHE", "id": "<wrangler kv namespace create brust-cache>" }]`;
  2. `{do:'BRUST_CACHE_DO'}` on an empty config → it contains `"durable_objects": { "bindings": [{ "name": "BRUST_CACHE_DO", "class_name": "BrustCacheDO" }] }` and `"migrations": [{ "tag": "brust-cache-v1", "new_sqlite_classes": ["BrustCacheDO"] }]`;
  3. bindings + `migrations` → ok; bindings + `exports.BrustCacheDO {type:"durable-object",storage:"sqlite"}` → ok; `new_classes` → an error naming `new_sqlite_classes`;
  4. the top level ok but `env.staging` without `kv_namespaces` → the error names `env.staging`;
  5. a DO binding with `script_name` → error;
  6. the input is never mutated (`structuredClone` equality), and a user's own DO class + migration are left alone.
- [ ] **Tests** `cf-entry.test.ts`: a DO-cache input → exactly one `export { BrustCacheDO } from "@brust/cache-cloudflare/do"`; without `[cache]` → today's output (D3 unchanged).
- [ ] **Tests** `cf-build.test.ts` (lane 4's fake core-cf fixture), temp apps:
  - `[cache] adapter="cloudflare-kv"`, `broadcast="cloudflare-do"` + a complete `wrangler.jsonc` → `dist/cf/worker/main.js` equals the R1 text; `dist/cf/wrangler.jsonc` `main == "worker/main.js"`; the smoke passes;
  - the same without bindings → BuildError `cf-config` with the snippet, and no `dist/` written;
  - `adapter="cloudflare-kv"` alone → no `main.js`, `main == "worker/index.js"`;
  - no `[cache]` → bytes identical to a base build of the same app.
- [ ] Implement:
  - `cf-entry.ts`: input `doClass: boolean` → the extra line;
  - `cloudflare.ts`: compute `need` from `manifest.cache` (the R2 trigger); verify right after `mergeWrangler` (:240), before `wrangler.jsonc` is written (:242); write `worker/main.js` and pass `main: 'main.js'`; refuse if `p.core.workerDir/main.js` exists;
  - extend the smoke preload (:154) to `{ env: {}, waitUntil() {}, DurableObject: class {} }`.
- [ ] `(cd packages/brust && bun test test/cf-cache-bindings.test.ts test/cf-entry.test.ts test/cf-build.test.ts && bun run typecheck)` → green; `bun test tests/cf/entry.test.ts` → pass. Commit.

### Task 9 — conformance under local workerd (R5, R15)
- [ ] `tests/cf/cache-cloudflare/harness.ts`: a Worker importing `../../../packages/cache-cloudflare/src/{kv,do,combine}.ts` and re-exporting `BrustCacheDO`.
  - `POST /call { kind: 'kv'|'do'|'kvdo', ns, target: 'store'|'broadcast', op, args }`, bodies base64;
  - one cached adapter per `ns`, `init({ namespace: ns, buildId: 'test', runtime: 'workers', workerId: 0 })`; kv built with `min_ttl_s: 0`.
- [ ] `tests/cf/cache-cloudflare/wrangler.jsonc`: `main harness.ts`; KV `{binding:"BRUST_CACHE", id:"cache-cloudflare-local"}`; the DO binding + `migrations` (`new_sqlite_classes`); `vars { BRUST_CACHE_TEST: "1" }`; `compatibility_date "2026-10-01"`; `compatibility_flags ["nodejs_compat"]`.
- [ ] `tests/cf/cache-cloudflare/proxy.ts`: `proxyAdapter(base, kind, ns) → CacheAdapter`, each method → `/call`.
- [ ] `tests/cf/cache-cloudflare-conformance.test.ts` (`describe.skipIf(process.env.BRUST_CF_E2E !== '1')`; `startWrangler` from `pokedex-d1/remote.ts`; `make = (kind) => () => proxyAdapter(base, kind, crypto.randomUUID())`):
  - `runConformance(make('kv'), { guard: false, invalidate: false })`;
  - `runConformance(make('do'), { pull: true, guard: true })`;
  - `runConformance(make('kvdo'), { pull: true, guard: true })`;
  - SQL-path cases: a DO-store row > 1_900_000 → `set` false; `__regen()` → the next `since` has a new `gen` and a `seq` ≥ the old one (R7); expired rows are gone after an `alarm`.
- [ ] `BRUST_CF_E2E=1 bun test --timeout 900000 tests/cf/cache-cloudflare-conformance.test.ts` → all pass, run twice. Commit.

### Task 10 — Workers e2e with the DO (lane A's cases + DO cases)
- [ ] Fixture `tests/fixtures/cf-cache/` (cf-l2's shape; no root `input.tsx`):
  - `package.json` `@brust/fixture-cf-cache` (deps as cf-min + `@brust/cache-cloudflare: workspace:*`);
  - `routes.tsx`: `/items/{id}` with `cache: { ttl_seconds: 600, tags: ['items'] }`;
  - `actions.ts`: `POST /bump {tag}` → `cache.invalidate`; `POST /e2e/remote {args}` → an epoch publish with origin `remote` and no local invalidate; `POST /e2e/regen`;
  - `brust.kvdo.toml` (`adapter="cloudflare-kv"`, `broadcast="cloudflare-do"`, `epoch_interval_ms=250`, `[cache.cloudflare] kv_min_ttl_s=300`, `[cloudflare] stats=true`) and `brust.do.toml` (`adapter="cloudflare-do"`, `do_store=true`, same interval and stats);
  - `wrangler.jsonc` with both bindings, the migration and `vars.BRUST_CACHE_TEST`;
  - `scripts/build-cf.ts <variant>` copies `brust.<variant>.toml` → `brust.toml` (gitignored) and builds with `--out-dir dist-<variant>`.
- [ ] `tests/cf/cache-cloudflare.test.ts`: per variant (`kvdo`, `do`), one wrangler each; `sleep(300)` is a lower bound only:
  1. `/items/7` MISS → `/__brust_e2e/l1-clear` → `HIT-L2` with the same body; `loader_calls` unchanged;
  2. `/e2e/remote {tags:['items']}` → sleep → `/items/7` MISS; `l2.received` +1;
  3. a remote invalidation, then l1-clear → not `HIT-L2` (kvdo: the JS floor; do: the row was deleted);
  4. `POST /bump` → sleep → `l2.skipped_own` +1, `l2.published` +1, DO `__state().publishes` +1 (L3: no re-publish, one memoized publish);
  5. `/e2e/regen` → sleep → a warm page is a MISS; `l2.resets` +1;
  6. **new-isolate floor (kvdo, R6):** store `/items/7`, remote-invalidate `items`, restart wrangler on the same `--persist-to` (DO seq and KV persist; a new isolate) → `/items/7` is not `HIT-L2`, and stats show `l2.epoch_polls ≥ 1` from a fresh 0;
  7. `dist-kvdo/cf/worker/main.js` equals the R1 text; `wrangler deploy --dry-run` → exit 0.
- [ ] `BRUST_CF_WASM_READY=1 BRUST_CF_E2E=1 bun test --timeout 900000 tests/cf` → all pass; the cf-min / pokedex / cache-adapter lines equal `$OUT/cf-before.txt`. Commit.

### Task 11 — pokedex comments, ci line
- [ ] `examples/pokedex/brust.toml`: append a commented block: `# [cache]`, `# adapter = "cloudflare-kv"`, `# broadcast = "cloudflare-do"`, `# epoch_interval_ms = 5000`, `# [cache.cloudflare]`, `# kv_min_ttl_s = 300`, and `# needs: bun add @brust/cache-cloudflare` + the bindings in wrangler.jsonc.
- [ ] `examples/pokedex/wrangler.jsonc`: the R10 snippet as `//` comments inside the object.
- [ ] `bun test --timeout 120000 tests/server/pokedex.test.ts` → 0 fail; `(cd packages/create-app && bun test test/sync-template.test.ts)` → green.
- [ ] `ci.yml` `cf` job: one line `cd packages/cache-cloudflare && bun run typecheck && bun test` before the `tests/cf` line. Commit `chore(cache-cloudflare): pokedex hint, ci line`.

### Task 12 (optional, R13) — ONE real deploy
- [ ] Only if R13 is accepted and `$WR whoami` exits 0.
- [ ] `tests/cf/cache-cloudflare-edge.ts`, modelled on `pokedex-d1-edge.ts`:
  - `N=brust-test-cache-cloudflare-<sha>`; `kv namespace create N` (the id parsed, never printed);
  - build `cf-cache` `kvdo` with `epoch_interval_ms=1000`; a deploy config with `name N` and the KV id; `deploy`;
  - 20 trials: warm `/items/7` (two GETs), `POST /bump`, then poll every 100 ms until the body's `n` changes; record the ms; print `min/median/max` only;
  - `finally`: the R13 delete sequence, then `deployments list --name N` and `kv namespace list | grep -c N` → both show nothing (else delete again and mark failed).
- [ ] Record the create/delete commands (no ids) for the note. Commit the script only.

## Acceptance
- **A1:** `(cd packages/cache-cloudflare && bun run typecheck && bun test)` → 0 fail; `rg -n "from ['\"]bun" packages/cache-cloudflare/src` → empty.
- **A2:** `(cd packages/brust && bun run build:debug && bun run typecheck && bun test)` → 0 fail; `bun test tests/cf/entry.test.ts` → pass (D3).
- **A3:** `BRUST_CF_E2E=1 bun test --timeout 900000 tests/cf` → conformance kv / do / kvdo green; `cache-cloudflare.test.ts` 2 × 7 pass; every pre-existing file unchanged vs `$OUT/cf-before.txt`.
- **A4:** a no-`[cache]` build of `tests/fixtures/cf-min` is byte-identical to the base: `diff -r $OUT/cf-min-before tests/fixtures/cf-min/dist/cf` (worker + wrangler.jsonc) → empty.
- **A5:** `bun pm pack` in `packages/cache-cloudflare` → the tarball holds `src/**`, `README.md` and `package.json` only, with no `workspace:` in the packed `package.json` [I: verify bun rewrites a peer `workspace:*`; if not, pin `^<version>` and say so in the note].
- **A6:** `bun test --timeout 120000 tests/server/pokedex.test.ts` → 0 fail; `git diff origin/m4cf --stat -- crates npm .github/workflows/release.yml scripts` → empty.

## Gates
- `cd packages/brust && bun run build:debug && bun run build && bun run typecheck && bun test`.
- `packages/cache-cloudflare`: `bun run typecheck && bun test`.
- `bun test --timeout 120000 tests/server/pokedex.test.ts`; `bun test --timeout 120000 tests/server/hydrate.chromium.test.ts`.
- `(cd packages/create-app && bun test)` (template sync).
- `BRUST_CF_E2E=1 bun test --timeout 900000 tests/cf`; `bun install --frozen-lockfile` clean.
- Rust gates are unaffected (no crate touched); run `cargo fmt --all -- --check` once to prove it. No bench: no native path is touched.

## Risk ledger
- **Smoke import of the DO class.** Without the `DurableObject` stub (:154), every DO-configured build fails with `Class extends value undefined`. Task 8's cf-build case catches it.
- **Bindings read at import.** Any top-level `env.X` read breaks the smoke (env = `{}`). The Proxy-env unit tests fail first.
- **Composer hook.** If lane A composes at more than one site (native + Workers), every site must call `composeWith`. Task 1 records them; a missed site shows as Task 10 cases 3/6 failing on `kvdo`.
- **Seq comparability.** A DO restart that resets `seq` would make DO-store guards refuse every write (old `inval` seqs) and would make KV floors misjudge. Task 9's `__regen` case (seq ≥ old) and Task 10 case 6 catch it.
- **Memo by `args` identity.** If lane A clones `args` between `store.invalidate` and `publish`, two epoch publishes happen (harmless: one extra own echo, one extra seq). `__state().publishes` in Task 10 case 4 exposes it: report it, do not weaken the assertion.
- **KV local semantics.** Miniflare KV is strongly consistent and ignores `cacheTtl`, so propagation lag cannot be tested locally (documented; R13 measures only the DO bound).
- **Free quotas in the real deploy.** Task 12 makes ≤ ~200 requests; nothing else touches the account.
- **Subrequests.** A `do_store` invalidation = 17 subrequests inside the action's invocation. An action that already makes > 33 subrequests exceeds Free's 50 → shard invalidates fail → `publish_errors`. The README states it.
- **workerd single isolate [I].** Case 6 relies on a wrangler restart for a "new isolate". If module state survives the restart, the case passes vacuously; the `epoch_polls` reset assertion guards that.
- **Shared host.** Kill only spawned wrangler PIDs; never `pkill` by pattern.

## Reporting
`conclave task note 838f12fb-70c1-41b7-acf2-d4065cf6bb64 cache-cloudflare READY @<sha> …` with:
- the base sha and the commit list; R1-R15 as implemented; the `$OUT/spike.md` summary;
- the A1-A6 outputs (counts); the `/_brust/cache/stats` `l2` object from each Task 10 variant;
- the exported API list; the README R14 table;
- Task 12's `min/median/max` staleness and the create/delete commands (no ids), or "not run".

**Release handoff (lane 6's owner applies; this lane edits none of these files):**
1. `scripts/release-files.ts` `FILES` += `'packages/cache-cloudflare/package.json'` (10 → 11; 11 → 12 if `cache-redis` lands first), and the counts in `scripts/release-check.test.ts`.
2. `scripts/release-bump.ts` bumps it. No optional-deps change: it is not a core dependency.
3. `release.yml`: the dry-run loop (today :68) adds `packages/cache-cloudflare` AFTER `packages/brust`; publish adds `pub packages/cache-cloudflare @brust/cache-cloudflare` after `pub packages/brust @brust/core` (it peers on core) and before create-app; the dist-tag list (today :130) adds `@brust/cache-cloudflare`.
4. The packed-tarball check: no `workspace:` in its `package.json`.

Escalate with `conclave task challenge 838f12fb-70c1-41b7-acf2-d4065cf6bb64 cache-cloudflare "<what, evidence>"` when:
- a Task 2 check fails;
- an `[A]` name differs from the merged code;
- the composer hook needs more than 5 lines, or a site in Rust;
- the D3 snapshot or a no-cache build changes;
- a file outside the Boundary is needed.
