# cache-redis: `@brust/cache-redis`, the built-in Redis/Dragonfly cache adapter (Bun `RedisClient`, Lua stale-write guard, pub/sub broadcast), conformance on real servers, two-process native e2e
**RULED by lead Detoro 2026-10-12 (before dispatch): R1-R15 ALL ACCEPTED as their defaults — incl. R1 one Cluster hash tag `{brust:<ns>}` with namespace-wide index/marker/seq/channel keys (rolling deploys), page keys build-scoped via lane A's L2Key; R2 binary bodies via a staging key + binary-safe `set(…,"PX")` renamed into place by the Lua guard, read with `getBuffer` pipelined with `GET seq`; R4 `store.invalidate` + `broadcast.publish` on the same args run as ONE atomic script (bump seq, raise markers, collect + delete index sets, PUBLISH) — this SATISFIES lane A's ruling L7 (marker before delete, publish after the store mutation) and is the preferred shape; R6 EVALSHA with locally computed hashes + NOSCRIPT → EVAL; UNLINK in batches of 500; R7 workers + 1 connections, own reconnect loop (100 ms doubling to 5 s with jitter), fail-fast while down, boot never blocked; R8 on (re)subscribe read `GET seq` once and call `onGap` if it moved (spec §4.2.5 governs over the brief's "fetch nothing"), no extra counter — outages show as resets/errors + a redacted log line; R9 CI service containers redis:7.4 + dragonfly v2.0.2 in the existing `server` job with `BRUST_REDIS_REQUIRED=1`; R10 `[cache.redis]` keys added to lane A's `parseCache`. Docker absent locally → the lead runs the env-gated suites against the CI containers via the m4cf → v2 PR, and the implementer may run redis via `bunx`-free means only if already installed; otherwise rely on CI and say so in READY. release.yml lines handed to lane 6 (now merged or in review — whichever lands first, the second lane rebases). Base: m4cf after lane A merges. Implementer Tiësto, reviewer Mellow. Worktree via `conclave lane start` FROM /Users/detoro/code/brust.**
owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · base: m4cf after lane A `cache-adapter-core` merges · lane: cache-redis · tier: standard · review: complex
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

This is lane B of the ruled spec `docs/design/2026-10-12-cache-adapter-design.md`: §3.1 interface, §4.2 correctness rules, §5.1 Redis/Dragonfly design, §7 packaging, §9 tests, R13. The ruled plan of lane A, `docs/plans/2026-10-12-cache-adapter-core.md`, is the contract: R1 (native = push only), R8 (built-in subpaths, `env:` rule), R9 (fixed counter set), R10 (native gap rule), R12/Task 10 (two-process e2e), R15 (conformance subpath), L1 (`entryStamp`), L3 (replay never re-publishes). Review is complex (Mellow) because of the Lua guard. Implementer: Tiësto.

Grounding: `m4cf` @**c019969** (lane A plan ruled, lane A NOT merged yet). `[A]` marks a fact taken from lane A's ruled plan that Task 1 re-anchors in the merged code. `[C]` marks a Bun or Dragonfly doc fetched 2026-10-12. `[I]` marks an inference that a task verifies.

## Facts the plan rests on
- **Workspace.** Root `package.json` `workspaces` contains `"packages/*"`, so `packages/cache-redis` is a member with no root edit. The fixture `tests/fixtures/l2-redis` needs one new entry (cf-min is listed explicitly).
- **Packaging conventions.** `@brust/core` and `@brust/runtime-dom` ship TS sources (`exports` → `./src/*.ts`). Both are version `2.0.0-alpha.2`, with `"typecheck": "bun check"`. `packages/runtime-dom/tsconfig.json` is the tsconfig template (strict, `noUncheckedIndexedAccess`, `types: ["bun"]`).
- **Release scripts.**
  - `scripts/release-files.ts:3`: `FILES` has 9 entries (core, runtime-dom, create-app + 6 natives).
  - `scripts/release-check.test.ts:24-28` asserts `✓ 9/9`, and the titles say "nine".
  - `scripts/release-bump.ts:14` sets `EXPECTED = FILES.length`; `:26-33` verify `packages/brust` deps only.
  - Lane 6 `m4cf-ci` (ruled, not merged) takes `FILES` to 10 (`npm/core-cf`) and owns `.github/workflows/release.yml`. Its ruled R8 replaces the dry-run loop `:68` and the publish order `:126-130`.
- **CI.** `.github/workflows/ci.yml` `server` job :144-194: `ubuntu-latest`, `timeout-minutes: 60`, builds the addon (:163), and runs the `packages/brust` unit line :166 and `tests/server/pokedex.test.ts` :184. CI runs only on PRs to `v2` (:6-10), so for this lane the implementer runs every CI command locally. Lane A appends `tests/server/cache-adapter.test.ts` after :184 [A].
- **Bun `RedisClient`** [C bun.com/docs/runtime/redis + `bun-types@1.4.2/redis.d.ts`]:
  - RESP3; `new RedisClient(url, { connectionTimeout=10000, idleTimeout=0, autoReconnect=true, maxRetries=20, enableOfflineQueue=true, enableAutoPipelining=true, tls })`.
  - URL schemes: `redis://`, `rediss://`, `redis+tls://`, `redis+unix://`. The no-arg constructor reads `REDIS_URL`/`VALKEY_URL`, so this lane always passes the URL explicitly.
  - **`send(command, args: string[])` is typed string-only.** Binary values go through `set(key, value: KeyLike = string | ArrayBufferView | Blob, "PX", ms)`, and `getBuffer` returns `Uint8Array | null`. `get`/`mget` return strings, so they are not binary-safe for bodies.
  - Pub/sub: "added in Bun 1.2.23", "experimental". A subscribed client may call only `subscribe`/`unsubscribe`/`ping`. The listener signature is `(message: string, channel: string)`; "Buffer subscriptions are not yet implemented".
  - `onconnect`/`onclose(error)`/`connected`/`connect()`/`close()`/`duplicate()`. After `maxRetries` "the client gives up and runs `onclose`". The docs do not say whether subscriptions are restored on reconnect.
  - Server ≥ 7.2. The repo runs Bun 1.4.3 locally; CI uses `canary` and release uses `1.4.2`.
- **Dragonfly** [C dragonflydb.io/docs/command-reference/compatibility; …/managing-dragonfly/scripting; …/getting-started/docker]:
  - GET, INCR, SADD, SMEMBERS, SUNION, DEL, UNLINK, PEXPIRE, PTTL, RENAME, EXISTS, EVAL, EVALSHA, SCRIPT LOAD/EXISTS, PUBLISH, SUBSCRIBE and HELLO are "Fully supported". SET is partial (missing only IFEQ-family, PX ok). SCRIPT FLUSH lacks ASYNC/SYNC; CLIENT TRACKING is partial and is not used here.
  - Lua: by default Dragonfly "forbids accessing undeclared keys from scripts" (opt-in flag `allow-undeclared-keys`), and it uses Lua 5.4. Every script below declares every key it touches.
  - Run with `--ulimit memlock=-1`. The image is `docker.dragonflydb.io/dragonflydb/dragonfly`. The latest tags are v2.0.2 (2026-10-07) and v2.0.0 (2026-09-16).
- **Lane A contract** [A]:
  - `CacheAdapter { name, runtimes, store?, broadcast?, init?(ctx {namespace, buildId, runtime, workerId}), close? }`.
  - `CacheStore.get → { page, stamp, entryStamp, storedAt }`, `set(key, page, meta {ttlMs, tags, method, path, stamp: number|null}) → boolean`, `invalidate(args)`, `maxBodyBytes`.
  - `CacheBroadcast.publish(args, origin) → seq` and `subscribe(on, onGap) → Promise<unsubscribe>`.
  - The L2 key is `"<namespace>:<build_id>:p:" + hex(blake3(…))`, opaque to adapters.
  - `afterInvalidate` runs `Promise.allSettled([store?.invalidate(args), broadcast?.publish(args, origin)])`: the same args object, the same tick, invalidate first.
  - Built-in `redis` → `@brust/cache-redis` and `dragonfly` → `@brust/cache-redis/dragonfly`. The default export is a factory called with `[cache.redis]`, with `env:` strings resolved from `process.env` at worker boot. `[cache.redis].url` must be `env:NAME` at build.
  - Worker 0 subscribes; `seq > lastSeq+1` → `cacheClear`; `onGap()` → clear + forget lastSeq.
  - The counter set is fixed: `hits … poll_errors` + `set_oversize`. Adapters cannot bump counters.
  - `runConformance(make, {push, pull, guard})` lives at `@brust/core/cache-adapter/conformance`. `make` may return a Promise.
- **InvalidateArgs** (`crates/brust-core/src/config.rs:160-171`, `packages/brust/src/native.ts:8-13`): `{ key?, tags?, path?, method? }`. L1 path invalidation uses `method ?? "GET"` (`core.rs:159-162`).
- **Pokedex** `examples/pokedex/brust.toml` (12 lines) has no `[cache]`. `packages/create-app/scripts/sync-template.ts` copies it into the gitignored template, so a TOML comment block flows into scaffolds unchanged.

## Goal
- `@brust/cache-redis` (workspace `packages/cache-redis`, lockstep version) exports:
  - `default`/`redisAdapter(options)` and `@brust/cache-redis/dragonfly` `default`/`dragonflyAdapter(options)`. Each returns a `CacheAdapter` with `runtimes: ['bun']`, a `store`, and a push `broadcast`.
  - No npm dependency: the Bun `RedisClient` only; the peer is `@brust/core`; `engines.bun >= 1.2.23`.
- **Key schema** (P = `{brust:<ns>}`; the braces are a Cluster hash tag, so every key shares one slot):
  - `P:page:<L2Key>`: the framed body (R3), `PX` = ttl;
  - `P:tag:<tag>` and `P:path:<METHOD> <path>`: SETs of page keys;
  - `P:inval:tag:<tag>` and `P:inval:path:<METHOD> <path>`: the seq of the last invalidation, `PX` = `marker_ttl_ms`;
  - `P:seq`: the INCR counter; `P:stage:<uuid>`: a 30 s staging key (R2);
  - the pub/sub channel `brust:<ns>:inval`.
  - Only page keys are build-scoped, because the L2 key carries `build_id` (R1).
- **The store operations:**
  - `get` = pipelined `getBuffer(page)` + `get(seq)` → `{ page, stamp: seq, entryStamp, storedAt }`.
  - `set` runs the `SET_LUA` guard: it refuses when any `inval` marker of its tags or of its `METHOD path` is greater than `meta.stamp` (`null` = unguarded).
  - `invalidate` and `publish` for the same args share ONE `INVAL_LUA` run (R4): INCR seq → raise the markers → SUNION + DEL the index sets. Then the members are UNLINKed in batches of 500, and then `PUBLISH {seq, origin, args}`. A `key`-only invalidation is a store no-op that is still published (spec §4.2.7).
- **Subscribe** uses one dedicated subscriber connection per process (worker 0). It reconnects with capped backoff, and after every re-subscribe it compares `GET seq` with the last seq seen → `onGap()` (R8).
- Conformance (lane A suite, `{push: true, guard: true}`) is green against real `redis:7.4` and Dragonfly `v2.0.2`: locally env-gated (`BRUST_REDIS_URL`, `BRUST_DRAGONFLY_URL`), mandatory in CI via service containers in the `server` job.
- `tests/server/cache-redis.test.ts` re-runs lane A's two-process native e2e over Redis and over Dragonfly, with a fail-open case against a dead port.
- `examples/pokedex/brust.toml` gains a commented `[cache] adapter = "redis"` block (no behaviour change). The docs section and the `release.yml` lines are handed off (Reporting).

## Rulings requested
**R1 — Scope of index sets, markers and seq.** *Default:* only page keys are build-scoped. Tag/path index SETs, `inval` markers, `seq` and the channel are **namespace-level**. During a rolling deploy, an invalidation from a build-B2 process must delete the build-B1 pages that B1 processes still read as `HIT-L2`: native has no floor check (that is Workers only). *Alternative:* the spec §5.1 text `{…}:<build>:t:<tag>` (per-build indexes). An invalidation issued by a new-build process then leaves old-build pages served ≤ ttl.

**R2 — How the body reaches the guarded write.** *Default:* a staging key.
- `set(P:stage:<uuid>, framed, "PX", 30000)` uses the typed binary-safe path. `EVALSHA SET_LUA` follows on the same auto-pipelined connection (one round trip).
- The script RENAMEs the staging key on success and DELs it on refusal.

*Alternative:* pass the body as an EVALSHA ARGV through `send()`. That saves a key write but relies on `send` accepting `Uint8Array`, which is untyped and undocumented. Task 2 records the spike result for the reviewer either way.

**R3 — Value encoding.** *Default:* one binary string per page, as spec §5.1: `[u32 LE meta_len][meta JSON {v:1,status,headers,entryStamp,storedAt,tags,method,path}][body]`. It is read with `getBuffer` + `GET seq` pipelined. MGET is not used: Bun returns strings, which corrupts binary bodies. An unknown `v` or a truncated frame → a miss (throws; lane A's bridge counts it in `errors`). *Alternative:* a JSON meta key + a raw body key (two TTLs to keep in step), or a hash (no binary-safe `hgetall` in Bun).

**R4 — Atomic invalidation (the guard's other half).** *Default:* the adapter pairs `store.invalidate(args)` and `broadcast.publish(args, origin)`.
- Pairing key: canonical args JSON (sorted tags, upper-case method). Each pending entry serves at most one invalidate and one publish, and is created synchronously before any await.
- One `INVAL_LUA` run then does three things atomically: `N = INCR seq`, marker = max(marker, N), and SUNION + DEL of the index sets.
- A publish with no partner (a composed broadcast) runs mode `publish` (INCR + markers, no deletes).
- An invalidate with no partner runs mode `delete`: the markers become max(marker, seq+1) and seq is not INCRed, so seq never jumps without an event.

*Alternative:* two independent scripts, with publish raising the markers and invalidate deleting. Lane A issues invalidate first, so a set can land between the delete and the marker raise: a stale page then survives ≤ ttl. With the markers set by invalidate instead, a publish that runs first leaves the markers above every future stamp, so writes for that tag stay blocked until the next invalidation.

**R5 — UNLINK vs DEL.** *Default:* UNLINK (non-blocking free; Dragonfly fully supported) for page members outside the script, in batches of `unlink_batch` = 500. DEL inside the scripts, for index sets and the staging key (small, must be atomic). *Alternative:* DEL everywhere (blocking free of up to `max_body_bytes` × 500 per call).

**R6 — Script loading.** *Default:* the SHA1 of each script source is computed at module load (`Bun.CryptoHasher('sha1')`). Every call is `EVALSHA`; on a `NOSCRIPT` error → `EVAL` (which also caches it). A server restart, a failover or SCRIPT FLUSH heal on first use. There is no SCRIPT LOAD at init. *Alternative:* SCRIPT LOAD at init and on every reconnect (an extra round trip per (re)connect, and it still needs the NOSCRIPT path for failover).

**R7 — Connections.** *Default:*
- each Bun worker has one command client (`new RedisClient(url, opts)`);
- worker 0 adds one subscriber client, created lazily by `subscribe()` with `new RedisClient` (not `duplicate()`, so its options can differ).
- A process with W workers holds W + 1 connections.
- Nothing is shared across workers (separate isolates).

*Alternative:* `duplicate()` of the command client for the subscriber (inherits `autoReconnect`, which R8 turns off).

**R8 — Reconnect, backoff, tier 1 during a disconnect, gap check.** *Default:*
- Both clients use `autoReconnect: false` and `enableOfflineQueue: false`, with an adapter-owned loop: delay `reconnect_min_ms` = 100 ms × 2^k, capped at `reconnect_max_ms` = 5000, ±20 % jitter, forever until `close()`.
- While disconnected, commands reject at once (no queued `get` pinning a worker slot until `get_timeout_ms`). Tier 1 keeps serving; L2 `get`/`set` failures land in lane A's `errors`, and failed publishes in `publish_errors`.
- After every re-SUBSCRIBE the adapter reads `GET seq`. When it is greater than the last seq it delivered (or than the baseline read at the first subscribe), it calls `onGap()` once, so tier 1 clears (spec §4.2.5 "on (re)subscribe").
- **There is no `broadcast_errors` counter.** Lane A R9 fixes the key set, and adapters cannot count. A disconnect shows as `resets` (the gap clear) plus a rate-limited `console.warn` (the first failure, then every 10th, URL redacted).

*Alternatives:*
- (a) The lead's suggestion: fetch nothing on reconnect and rely on the next event's seq jump. An event lost during the outage that is also the last one stays undetected ≤ ttl.
- (b) Call `onGap()` unconditionally on every reconnect.
- (c) Challenge lane A to add `broadcast_errors` (touches `L2Counters` and the pinned stats shape).

**R9 — Boot with Redis unreachable.** *Default:* `init` never throws for network reasons. It tries one connect bounded by `connect_timeout_ms` (default 2000), warns, starts the R8 loop and resolves. It throws (→ boot error) only for invalid options: empty `url` (the env var is unset), an unknown key or a bad type. *Alternative:* fail the worker boot when Redis is down (strict, but a Redis outage then takes the whole site down at deploy).

**R10 — `[cache.redis]` keys and where they are validated.** *Default:* the snake_case keys
- `url` (required; `env:` at build per lane A R8);
- `tls`;
- `connect_timeout_ms` (100..=60000, default 2000);
- `max_body_bytes` (1..=67108864, default 1048576 = lane A's `[cache].max_body_bytes` default);
- `marker_ttl_ms` (60000..=604800000, default 86400000);
- `unlink_batch` (1..=10000, default 500);
- `reconnect_min_ms` (10..=60000, default 100);
- `reconnect_max_ms` (≥ min, default 5000).

The factory validates them at worker boot. This lane also adds the same key list to lane A's `parseCache` in `packages/brust/src/build/config.ts`, so a typo fails at `brust build`. `namespace` comes from `init` (`[cache].namespace`), not from this table. `marker_ttl_ms` only has to outlive the longest stamp→set window (render + 5 s set budget), not the page ttl, so a day is conservative; this deviates from spec §5.1's "2 × max ttl", which an adapter cannot know. *Alternative:* validation in the factory only (a typo surfaces at `brust start`).

**R11 — TLS and auth.** *Default:*
- Credentials live only inside `url` (`redis://user:pass@h` or `rediss://…`), which is always `env:`.
- `tls = true | { reject_unauthorized?: bool, server_name?: string, ca_file?: string }`; `ca_file` is read at boot into Bun `TLSOptions.ca`.
- Every message prints `host:port` only (the `redact(url)` helper), never userinfo or the query.

*Alternative:* separate `username`/`password = "env:…"` keys (more config surface, same secrecy).

**R12 — Dragonfly flavour.** *Default:* the same code. `dragonflyAdapter` differs only in `name: 'dragonfly'` and in the docs. Every script declares all keys, so no `allow-undeclared-keys` flag or `--!df` header is needed, and page members are UNLINKed outside the script exactly for that reason. *Alternative:* a Dragonfly-specific script header that deletes members inside the script (needs the global-lock flag: "Dragonfly has to stop all other operations").

**R13 — CI.** *Default:*
- service containers on the existing `server` job (the addon is already built there):
  - `redis:7.4` on 6379 with a `redis-cli ping` health check;
  - `docker.dragonflydb.io/dragonflydb/dragonfly:v2.0.2` on 6380 with `--ulimit memlock=-1`; readiness is the tests' own PING wait (≤ 15 s), because a health command inside that image is unverified [I];
- step env `BRUST_REDIS_URL`, `BRUST_DRAGONFLY_URL`, `BRUST_REDIS_REQUIRED=1`. With `REQUIRED` set, a missing URL fails instead of skipping, so a silent skip cannot pass for green.

*Alternatives:*
- a separate `cache-redis` job (needs its own addon build, ~10 min cold);
- floating `latest` tags;
- adding `redis:8.2` as a matrix leg.

**R14 — Bun pub/sub is "experimental".** *Default:* accept it. Every loss path ends in a seq gap or the R8 re-subscribe check, which means a tier-1 clear, never silent staleness beyond ttl. The docs note the status and the minimum Bun. *Fallback if it misbehaves:* pin the Bun version in `engines` and file upstream. Native accepts push only (lane A R1), so a polled `since` broadcast is not an option for this lane. *Alternative:* block the lane until Bun drops the label.

**R15 — Packaging and release ownership.** *Default:*
- `packages/cache-redis/package.json`:
  - `"name": "@brust/cache-redis"`, the lockstep version;
  - `exports {".": "./src/index.ts", "./dragonfly": "./src/dragonfly.ts"}`, `files ["src","README.md"]`;
  - `peerDependencies {"@brust/core": "workspace:*"}` (bun publish rewrites it to the exact version; Task 6 verifies the packed tarball), `engines {"bun": ">=1.2.23"}`, `publishConfig.access public`.
- This lane edits:
  - `scripts/release-files.ts` (+`packages/cache-redis/package.json`);
  - `scripts/release-check.test.ts` (the count literal: 10, or 11 if lane 6 merged first);
  - `scripts/release-bump.ts` (asserts that the peer is `workspace:*`).
- `release.yml` stays lane 6's: the exact lines are handed off in the READY note.

*Alternative:* lane 6 (or the lead at merge) does all release wiring.

## Boundary
- `packages/cache-redis/**` (new).
- `tests/server/cache-redis.test.ts` (new); `tests/fixtures/l2-redis/**` (new workspace member); root `package.json` (`workspaces` +1); `bun.lock` (the two new members only).
- `.github/workflows/ci.yml`: the `server` job's `services:`, `env:` and two `run:` lines only.
- `scripts/release-files.ts`, `scripts/release-check.test.ts`, `scripts/release-bump.ts` (R15 lines only).
- `packages/brust/src/build/config.ts`: the `[cache.redis]` key list inside `parseCache` only (R10). `packages/brust/test/build-config-cache.test.ts`: added cases only.
- `examples/pokedex/brust.toml` (a comment block only).
- **NOT:** `.github/workflows/release.yml` (lane 6), `docs/**` (lane D; hand-off text in Reporting), any other lane-A file, `crates/**`, `tests/server/{harness,cache-adapter}.ts`. Anything else → `conclave task challenge`.

## Tasks
`W=/Users/detoro/code/brust/.claude/worktrees/cache-redis`, `OUT=/private/tmp/cache-redis` (never committed), `WS=838f12fb-70c1-41b7-acf2-d4065cf6bb64`. Local servers: `R=redis://127.0.0.1:6379`, `D=redis://127.0.0.1:6380`. Commit per task with the Co-Authored-By trailer; never `git add -A`.

### Task 1 — worktree, base, servers, baselines
- [ ] Create the worktree with `conclave lane start` from `/Users/detoro/code/brust` (rule:worktree-location) at `$W` on `lane/cache-redis` from `origin/m4cf`. The plain-git equivalent: `git -C /Users/detoro/code/brust fetch origin && git -C /Users/detoro/code/brust worktree add $W -b lane/cache-redis origin/m4cf`.
  - `git -C $W log --oneline --grep 'merge: lane/cache-adapter-core' | wc -l` → 1 and `test -f $W/packages/brust/src/cache-adapter/conformance.ts && echo A` → `A`; else challenge: wrong base.
- [ ] `cd $W && bun install --frozen-lockfile && (cd packages/brust && bun run build:debug)` → exit 0.
- [ ] Re-anchor every `[A]` fact. Read and record into `$OUT/anchors.txt`:
  - `cache-adapter/types.ts` (exact `CacheStore`/`CacheBroadcast`/`GetResult`/`SetMeta` signatures);
  - `conformance.ts` (does it call `init`/`close`? the case count);
  - `runtime.ts` `afterInvalidate` (the call order);
  - `load.ts` (factory call, `env:` resolution, the options object);
  - `build/config.ts` `parseCache` (how `[cache.redis]` keys are handled today);
  - `tests/server/cache-adapter.test.ts` and `tests/fixtures/l2-relay/` (helpers to copy).
  Any difference from this plan → challenge before Task 2.
- [ ] Servers (own containers only; never `docker rm` by pattern):
  - `docker run -d --rm --name cr-redis-$$ -p 6379:6379 redis:7.4`;
  - `docker run -d --rm --name cr-df-$$ -p 6380:6379 --ulimit memlock=-1 docker.dragonflydb.io/dragonflydb/dragonfly:v2.0.2`;
  - record the two names in `$OUT/containers.txt`.
  - `bun -e "import {RedisClient} from 'bun'; for (const u of ['$R','$D']) { const c = new RedisClient(u); console.log(await c.send('PING', [])); c.close() }"` → `PONG` twice. No Docker → challenge (CI is not reachable from m4cf lanes).
- [ ] Baselines: `(cd packages/brust && bun test 2>&1 | tail -3)` → 0 fail; `bun test --timeout 120000 tests/server/cache-adapter.test.ts` → lane A's 5 pass; `bun test scripts/release-check.test.ts` → pass.

### Task 2 — package skeleton, options, frame, keys (pure; no server)
- [ ] Create `packages/cache-redis/`: `package.json` (R15; scripts `test`, `typecheck: bun check`; devDeps `@types/bun ^1.4.0`, `@brust/core: workspace:*`), `tsconfig.json` (copy of runtime-dom's, `include ["src","test"]`), `README.md` (5 lines, points to the docs page), `src/{index,dragonfly,adapter,options,frame,keys,lua,pairing,subscriber,redact}.ts`. `bun install` → `bun.lock` gains only this member.
- [ ] **Tests first**:
  - `test/options.test.ts`: the defaults table (R10); every out-of-range value names its key; an unknown key → `TypeError: cache-redis: unknown option "urll"`; `url: ''` → a TypeError naming `url` and not containing the value; `tls: {ca_file}` with a missing file → a TypeError naming `ca_file`.
  - `test/frame.test.ts`: encode/decode round trip incl. all 256 byte values and repeated headers; `v: 2` → `null`; a truncated buffer → throws; `meta_len` > length → throws.
  - `test/keys.test.ts`: `keys('ns').page('ns:b1:p:ab')` === `{brust:ns}:page:ns:b1:p:ab`; tag/path/inval/seq/stage shapes; `canonical({tags:['b','a'],path:'/x'})` === `canonical({path:'/x',method:'get',tags:['a','b']})`; key-only args → `hasStoreWork === false`.
  - `test/redact.test.ts`: `redact('rediss://u:s3cr3t@h:6380/0?x=1')` === `h:6380`; a garbage string → `<invalid url>`.
- [ ] Spike (R2 record, no product code depends on it): `bun -e` that `send('SET', ['k', new Uint8Array([0,255,10])])` then `getBuffer('k')`. Write the bytes or the error into `$OUT/send-binary.txt`.
- [ ] `cd packages/cache-redis && bun test test/options.test.ts test/frame.test.ts test/keys.test.ts test/redact.test.ts && bun run typecheck` → 0 fail. Commit `feat(cache-redis): package, options, frame, key schema`.

### Task 3 — Lua scripts, store get/set (R2, R3, R5, R6)
- [ ] `src/lua.ts` exports `SET_LUA`, `INVAL_LUA`, their SHA1s, and `evalsha(client, script, keys, argv)` (EVALSHA; `/NOSCRIPT/` → EVAL). The script text is exact (the reviewer checks it):
```lua
-- SET_LUA  KEYS = [stage, page, idx_1..idx_n, mark_1..mark_n]  ARGV = [stamp|"", ttl_ms, n]
local n = tonumber(ARGV[3]); local ttl = tonumber(ARGV[2])
if ARGV[1] ~= '' then
  local stamp = tonumber(ARGV[1])
  for i = 1, n do
    local m = redis.call('GET', KEYS[2 + n + i])
    if m and tonumber(m) > stamp then redis.call('DEL', KEYS[1]); return 0 end
  end
end
if redis.call('EXISTS', KEYS[1]) == 0 then return -1 end
redis.call('RENAME', KEYS[1], KEYS[2]); redis.call('PEXPIRE', KEYS[2], ttl)
for i = 1, n do
  redis.call('SADD', KEYS[2 + i], KEYS[2])
  local t = redis.call('PTTL', KEYS[2 + i])
  if t == -1 or (t >= 0 and t < ttl) then redis.call('PEXPIRE', KEYS[2 + i], ttl) end
end
return 1
```
```lua
-- INVAL_LUA  KEYS = [seq, idx_1..idx_n, mark_1..mark_n]  ARGV = [mode ('both'|'delete'|'publish'), n, marker_ttl_ms]
local unpack = table.unpack or unpack  -- Lua 5.1 (Redis) and 5.4 (Dragonfly)
local mode = ARGV[1]; local n = tonumber(ARGV[2]); local mttl = tonumber(ARGV[3])
local v
if mode == 'delete' then v = tonumber(redis.call('GET', KEYS[1]) or '0') + 1 else v = redis.call('INCR', KEYS[1]) end
for i = 1, n do
  local k = KEYS[1 + n + i]; local c = tonumber(redis.call('GET', k) or '0')
  if v > c then redis.call('SET', k, v, 'PX', mttl) else redis.call('PEXPIRE', k, mttl) end
end
local out = { mode == 'delete' and v - 1 or v }
if mode ~= 'publish' and n > 0 then
  local idx = {}; for i = 1, n do idx[i] = KEYS[1 + i] end
  for _, m in ipairs(redis.call('SUNION', unpack(idx))) do out[#out + 1] = m end
  redis.call('DEL', unpack(idx))
end
return out
```
  `n` = number of tags + (path ? 1 : 0); index i and marker i name the same tag or path. The first line of `INVAL_LUA` covers both Lua versions (Redis 5.1, Dragonfly 5.4); the tests prove both.
- [ ] `src/adapter.ts`:
  - `store.get`: `Promise.all([c.getBuffer(page), c.get(seq)])`; null → `{page:null, stamp, entryStamp:null, storedAt:null}`; otherwise decode → `{page, stamp, entryStamp: meta.entryStamp, storedAt: meta.storedAt}`. `stamp = Number(seq ?? 0)`.
  - `store.set`: `body.length > maxBodyBytes` → `false` with no I/O. Otherwise `c.set(stage, frame, 'PX', 30000)` then `SET_LUA`: `1` → true, `0` → false, `-1` → false + warn ("staging key vanished").
  - `maxBodyBytes` = option.
- [ ] **Tests first** `test/store.servers.test.ts`, parametrised `for (const [flavor, url] of servers())`. `servers()` reads `BRUST_REDIS_URL`/`BRUST_DRAGONFLY_URL`, skips a missing one, and throws when `BRUST_REDIS_REQUIRED=1` and either is missing. Each case uses `namespace = 't-' + crypto.randomUUID()` via `init`, and `afterAll` SCAN-UNLINKs `{brust:<ns>}:*` for every namespace it made (never FLUSHDB: shared dev servers). Cases:
  - round trip;
  - a stale stamp refused (and the staging key gone: `EXISTS stage` 0);
  - an unguarded write with `stamp: null`;
  - index TTL extended to the longest member;
  - a 1 MiB body;
  - after `SCRIPT FLUSH` the next set succeeds (the NOSCRIPT path) and `SCRIPT EXISTS sha` → 1;
  - a page whose meta `v` is 2 → `get` throws.
- [ ] `BRUST_REDIS_URL=$R BRUST_DRAGONFLY_URL=$D bun test test/store.servers.test.ts` → all pass for both flavours. Commit.

### Task 4 — invalidate/publish pairing, subscribe, reconnect (R4, R7, R8, R9)
- [ ] `src/pairing.ts`: `Pairing.run(args, side: 'invalidate'|'publish')` (R4). The entry is created synchronously; the first side to arrive sends the script; mode `both` if both sides arrive in the same tick (decided in a `queueMicrotask` before sending), else `delete`/`publish`. Results are `{seq, members}`. `invalidate` then UNLINKs the members in `unlink_batch` chunks. `publish` returns `seq` after `PUBLISH brust:<ns>:inval {"seq","origin","args"}`. Key-only args → `invalidate` resolves with no I/O and `publish` runs mode `publish` with `n = 0`.
- [ ] `src/subscriber.ts`:
  - `subscribe(on, onGap)`: a new client (`autoReconnect:false, enableOfflineQueue:false`) → `connect` → `subscribe(channel, listener)` → baseline `GET seq` on the command client.
  - The listener parses JSON. Invalid → warn and drop; otherwise `last = max(last, seq)` and `on(e)`.
  - `onclose` (not closing) → the backoff loop → reconnect, resubscribe, then `GET seq > last` → `onGap()` once and `last = that seq`.
  - Returns `async () => { closing = true; client.close() }`.
  - The command client gets the same loop. `init` follows R9. `close()` stops both loops and closes both clients.
  - Test hooks live under `__test`: `dropSubscriber()` (closes the socket as a network loss would) and `state()` (`{connected, subscribed, last, reconnects}`).
- [ ] **Tests first** `test/broadcast.servers.test.ts` (same `servers()` gate):
  - pairing: `Promise.allSettled([a.store.invalidate(x), a.broadcast.publish(x,'o')])` → seq +1 exactly, the markers equal that seq, the pages are gone;
  - standalone `publish` → +1, no deletes; standalone `invalidate` → seq unchanged, a set with the current stamp refused until the next publish;
  - 1 200 tagged pages invalidated → all gone (3 UNLINK batches);
  - push delivery with `origin` + `args` across two adapters; unsubscribe stops delivery;
  - gap on reconnect: `reconnect_min_ms: 300`, `__test.dropSubscriber()`, then publish from a second adapter within 50 ms → `onGap` called exactly once within 3 s, and `state().subscribed` true;
  - Redis only: `CLIENT KILL TYPE pubsub` → resubscribed within 3 s (on Dragonfly run it too; if the command is unsupported, record the error and skip that one case with a reason string);
  - offline: `url: 'redis://:s3cr3t@127.0.0.1:1'` → `init` resolves within `connect_timeout_ms + 500`; `store.get` rejects within 100 ms; no captured warn/error contains `s3cr3t`; a `process.on('unhandledRejection')` spy stays empty; `close()` stops reconnects (`state().reconnects` is stable over 500 ms).
- [ ] Both flavours → all pass. Commit.

### Task 5 — conformance (lane A suite) on both servers
- [ ] `test/conformance.redis.test.ts` and `test/conformance.dragonfly.test.ts`. Each calls `runConformance(async () => { const a = redisAdapter({ url }); await a.init!({ namespace: 'conf-' + crypto.randomUUID(), buildId: 'b1', runtime: 'bun', workerId: 0 }); track(a); return a }, { push: true, guard: true })` under `describe.skipIf(!url && process.env.BRUST_REDIS_REQUIRED !== '1')`. `afterAll` closes the tracked adapters and SCAN-UNLINKs their namespaces. If lane A's suite already calls `init`/`close` (Task 1 record), drop the duplicate call.
- [ ] `BRUST_REDIS_URL=$R BRUST_DRAGONFLY_URL=$D bun test test/conformance.*.test.ts` → the case count from `$OUT/anchors.txt` × 2, 0 fail. Run it twice. Commit.

### Task 6 — build validation, release refs, pack check (R10, R15)
- [ ] **Tests first** `packages/brust/test/build-config-cache.test.ts` (added cases):
  - `[cache.redis] urll = "env:X"` → BuildError naming `cache.redis.urll`;
  - `connect_timeout_ms = 0` → a range error;
  - all R10 keys valid → passes and appears unchanged in `manifest.cache.options`.
  Implement in `parseCache` (the key list + types only).
- [ ] Release refs:
  - `release-files.ts` `FILES` += `'packages/cache-redis/package.json'`;
  - `release-check.test.ts` count literal = the new `FILES.length`;
  - `release-bump.ts` adds `problems.push(...)` unless `packages/cache-redis` `peerDependencies['@brust/core'] === 'workspace:*'`.
  - Check: `bun test scripts/release-check.test.ts` → pass; `bun scripts/release-bump.ts "$(bun -e "console.log(require('./packages/brust/package.json').version)")"` → `✓ bumped N/N`, then `git diff --exit-code` → clean.
- [ ] `test/pack.test.ts` (in cache-redis): `bun pm pack --destination <tmp>` → the tarball lists only `package/{package.json,README.md,src/**}`. The packed `package.json` has no `workspace:`, and its `peerDependencies['@brust/core']` equals the core version. If bun leaves `workspace:*` in peers → challenge (R15 alternative `workspace:^`).
- [ ] `(cd packages/brust && bun test test/build-config-cache.test.ts && bun run typecheck)`; `(cd packages/cache-redis && bun test test/pack.test.ts)` → green. Commit.

### Task 7 — two-process native e2e over Redis and Dragonfly
- [ ] `tests/fixtures/l2-redis/`: copy `routes.tsx` and `actions.ts` from lane A's `tests/fixtures/l2-relay/` (`/items/{id}` cached, ttl 600, tag `items`; `/plain/{id}` uncached; `POST /bump {tag}`). `package.json` `@brust/fixture-l2-redis` with `@brust/cache-redis: workspace:*`. **No root `input.tsx`.** `brust.toml`:
  ```toml
  [actions]
  [cache]
  adapter = "redis"
  namespace = "l2redis"
  get_timeout_ms = 200
  [cache.redis]
  url = "env:BRUST_E2E_REDIS_URL"
  reconnect_min_ms = 100
  ```
  Root `workspaces` += `"tests/fixtures/l2-redis"`; `bun install` → `bun.lock` gains only it.
- [ ] `tests/server/cache-redis.test.ts`: `for (const [flavor, url] of servers())` (the same gate as Task 3, copied). It builds once and copies lane A's spawn/readiness helper. `beforeAll` SCAN-UNLINKs `{brust:l2redis}:*` on that server. Servers A and B run with `BRUST_E2E_REDIS_URL=url`; `afterAll` kills only its own PIDs.
  1. A `/items/7` → `MISS`; poll B ≤ 2 s → `HIT-L2` with A's `n`; B again → `HIT`; B stats `l2.adapter` === flavor (`redis`/`dragonfly`), `l2.hits` ≥ 1, `loader_calls` 0.
  2. Read `GET {brust:l2redis}:seq` = s0. POST `/bump {"tag":"items"}` on A → poll B ≤ 1 s for a fresh `n`. After 500 ms, `seq` === s0 + 1 (**L3: no re-publish**); B `l2.received` ≥ 1; A `l2.skipped_own` ≥ 1.
  3. `/plain/1` → `SCAN {brust:l2redis}:page:*` count unchanged.
  4. Fail-open: server C with `BRUST_E2E_REDIS_URL=redis://127.0.0.1:1` boots (R9). `/items/9` → 200 in < 2 s; `l2.errors + l2.timeouts` ≥ 1.
  5. Re-subscribe: Redis runs `CLIENT KILL TYPE pubsub` and Dragonfly the same or is skipped with a reason, per Task 4's record. Wait ≤ 3 s for the reconnect (poll B stats `l2.resets` or a bump/fresh cycle), then `/bump` on A → B fresh ≤ 2 s.
- [ ] `BRUST_REDIS_URL=$R BRUST_DRAGONFLY_URL=$D bun test --timeout 180000 tests/server/cache-redis.test.ts` → 10 pass (5 × 2), run twice. Commit.

### Task 8 — CI lines, pokedex comment, cleanup
- [ ] `ci.yml` `server` job: add under `runs-on`:
  ```yaml
      services:
        redis:
          image: redis:7.4
          ports: ["6379:6379"]
          options: --health-cmd "redis-cli ping" --health-interval 2s --health-timeout 2s --health-retries 15
        dragonfly:
          image: docker.dragonflydb.io/dragonflydb/dragonfly:v2.0.2
          ports: ["6380:6379"]
          options: --ulimit memlock=-1
      env: { BRUST_REDIS_URL: "redis://127.0.0.1:6379", BRUST_DRAGONFLY_URL: "redis://127.0.0.1:6380", BRUST_REDIS_REQUIRED: "1" }
  ```
  After lane A's `tests/server/cache-adapter.test.ts` line, add `- run: cd packages/cache-redis && bun run typecheck && bun test` and `- run: bun test --timeout 180000 tests/server/cache-redis.test.ts`. Check: `bun -e "Bun.YAML.parse(await Bun.file('.github/workflows/ci.yml').text()); console.log('yaml ok')"` → `yaml ok`.
- [ ] `examples/pokedex/brust.toml`: append a comment block (every line starts with `#`): `[cache]`, `adapter = "redis"   # or "dragonfly"; needs bun add @brust/cache-redis`, `[cache.redis]`, `url = "env:REDIS_URL"`. Check: `bun test --timeout 120000 tests/server/pokedex.test.ts` → 0 fail; `(cd packages/create-app && bun test test/sync-template.test.ts)` → pass.
- [ ] Stop exactly the containers in `$OUT/containers.txt`. Commit `ci(cache-redis): redis + dragonfly service containers; pokedex example block`.

## Acceptance
- **B1:** `(cd packages/cache-redis && bun run typecheck && BRUST_REDIS_REQUIRED=1 BRUST_REDIS_URL=$R BRUST_DRAGONFLY_URL=$D bun test)` → 0 fail, 0 skip. Conformance runs on both servers.
- **B2:** the same command without the URLs and without REQUIRED → the server files skip and the pure files pass. With `BRUST_REDIS_REQUIRED=1` and no URL → it fails, naming the env var.
- **B3:** `bun test --timeout 180000 tests/server/cache-redis.test.ts` (both URLs) → 10 pass, twice.
- **B4:** `rg -n "from ['\"](ioredis|redis|@redis)" packages/cache-redis` → empty. `jq '.dependencies // {}' packages/cache-redis/package.json` → `{}`.
- **B5:** the Lua text in `src/lua.ts` equals the plan's (the reviewer diffs it). `rg -n 'allow-undeclared-keys' packages/cache-redis` → empty.
- **B6:** `bun test scripts/release-check.test.ts` → pass. `bun scripts/release-bump.ts <current>` → `✓ bumped N/N` (N = 10 or 11) and the tree stays clean.
- **B7:** `(cd packages/brust && bun test test/build-config-cache.test.ts && bun test)` → 0 fail.
- **B8:** `bun test --timeout 120000 tests/server/pokedex.test.ts` and `bun test --timeout 120000 tests/server/cache-adapter.test.ts` → 0 fail (lane A untouched).
- **B9:** `git diff origin/m4cf --stat` lists only Boundary paths.

## Gates
- `cd packages/brust && bun run build:debug && bun run typecheck && bun test` (the `parseCache` edit).
- `cd packages/cache-redis && bun run typecheck && bun test` (both servers, REQUIRED=1).
- `bun test --timeout 120000 tests/server/pokedex.test.ts`; `bun test --timeout 120000 tests/server/cache-adapter.test.ts`; `bun test --timeout 180000 tests/server/cache-redis.test.ts` (new).
- `cd packages/create-app && bun test test/sync-template.test.ts test/scaffold.test.ts` (the pokedex toml flows into the template); `bun test scripts/release-check.test.ts`.
- No Rust file changes, so the cargo, battery, m2-exit, bench and wasm gates are unaffected. The lead's merge run still executes them.

## Risk ledger
- **Guard correctness (the review focus).** A wrong index↔marker order in KEYS silently disables the guard. The "stale stamp refused" case (Task 3) and the pairing case (Task 4) fail if it does. Marker expiry before a slow set → an accepted stale write; `marker_ttl_ms` ≥ 60 s by range check.
- **Pairing mismatch.** If lane A ever calls `invalidate`/`publish` in different ticks, R4 degrades to `delete` + `publish` modes: still correct, and stale writes stay blocked until the second script runs. The pairing test pins the same-tick behaviour; Task 1's `afterInvalidate` record pins the call shape.
- **Bun pub/sub on reconnect.** Undocumented resubscribe behaviour is why the subscriber owns its loop (R8). A test that hangs at "subscribed" means Bun changed `connect()` on a closed client: create a fresh client per attempt (already the design).
- **Lua 5.1 vs 5.4.** `unpack` differs (Dragonfly is 5.4). Both flavours run every script case, so a miss shows as `ERR … unpack` on Dragonfly only.
- **Shared dev servers.** Tests never FLUSHDB. Every namespace is random and SCAN-UNLINKed. The e2e namespace `l2redis` is fixed and cleaned in `beforeAll`.
- **Port clash.** Local 6379/6380 may be taken: use other host ports and pass them through the env vars; nothing hard-codes ports.
- **Secrets.** Every log path goes through `redact()`. The offline test greps captured output for the password.
- **Release skew with lane 6.** Both lanes edit `release-files.ts`/`release-check.test.ts`. Whichever merges second rebases; the count is `FILES.length` + 1 of its base. The release.yml lines are applied by lane 6 or the lead (Reporting).
- **CI only on m4cf → v2.** The service containers are first exercised on that PR. Locally proven commands (B1-B3) are the evidence; the YAML parse check catches syntax.
- **Shared host.** Kill only own PIDs and own containers (`$OUT/containers.txt`). Never `pkill`/`docker rm` by pattern.

## Reporting
`conclave task note 838f12fb-70c1-41b7-acf2-d4065cf6bb64 cache-redis READY @<sha> …` with:
- the commit list, the base sha (lane A merge sha), and R1-R15 as implemented;
- B1-B9 outputs (per-flavour pass counts, conformance count × 2, the two e2e runs), the Redis and Dragonfly versions as reported by `INFO server`, and `$OUT/send-binary.txt` (R2 spike);
- the B's `/_brust/cache/stats` `l2` object after e2e case 2, for both flavours.
- **Hand-off to lane 6 / lead, `release.yml` (exact lines):**
  - the dry-run loop gains `packages/cache-redis` after `packages/brust`;
  - after the packed-core checks, add `(cd packages/cache-redis && bun pm pack --destination /tmp/pack-cr) && tar -xOf /tmp/pack-cr/*.tgz package/package.json | (! grep -q 'workspace:')`, in both dry-run and publish;
  - after `pub packages/brust @brust/core`, add `pub packages/cache-redis @brust/cache-redis`;
  - the prerelease dist-tag list gains `@brust/cache-redis`.
- **Hand-off to lane D (docs section "Redis / Dragonfly"):**
  - the config block and the R10 option table;
  - the key schema;
  - guard semantics, with stale writes refused exactly;
  - the reconnect/gap behaviour (R8): what tier 1 does during an outage, and that an invalidation published during an outage is lost for remote instances (stale ≤ ttl);
  - Dragonfly notes (declared keys, `--ulimit memlock=-1`);
  - TLS/auth via `rediss://` + `env:`;
  - Bun ≥ 1.2.23 and pub/sub "experimental";
  - connections per process = workers + 1;
  - not for Workers (use a custom adapter, e.g. Upstash REST).

Escalate with `conclave task challenge 838f12fb-70c1-41b7-acf2-d4065cf6bb64 cache-redis "<what, evidence>"` when:
- lane A's merged API differs from the `[A]` facts;
- a needed file is outside the Boundary (e.g. a `broadcast_errors` counter);
- Docker or the servers are unavailable locally;
- Dragonfly rejects a used command or script;
- bun leaves `workspace:` in packed peers;
- a lane-A test changes result.
