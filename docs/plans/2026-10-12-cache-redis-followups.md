# cache-redis-followups: PUBLISH inside the invalidation script (Mellow N1) + orphaned-page retry (N2)

**RULED by lead Detoro 2026-10-12 (plan written by the lead from Mellow's REVIEW-PASS note dd437cba on `cache-redis`). DISPATCHED 2026-10-13 (its gate, the m4cf → v2 merge, passed with alpha.3; it was left planned by oversight). Base: v2 at dispatch; `packages/cache-redis/src/adapter.ts:80-82` still PUBLISHes after the script and nothing counts orphans, so both findings stand. Tier: standard. Implementer TBD (Tiësto has the context). Reviewer Mellow.**

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · base: v2 (after the m4cf PR) · lane: cache-redis-followups · tier: standard · review: complex

## Why
- N1: `@brust/cache-redis` runs `PUBLISH` after the publish-mode `INVAL_LUA` script, so two processes invalidating concurrently can deliver events to subscribers out of `seq` order. Lane A treats an inversion as a gap and clears tier 1 on every other instance — a hit-rate cliff under bursty multi-process invalidation, not a correctness bug.
- N2: index sets are `DEL`ed inside the script but pages are `UNLINK`ed afterwards in batches; a link drop between the two orphans pages (no index entry) until their TTL. Instances that replayed the event reject them via the floor.

## Tasks
1. Move `PUBLISH` into `INVAL_LUA`'s `publish`/`both` branches (`packages/cache-redis/src/lua.ts`, `pairing.ts`): scripts serialise, so delivery order = seq order. Verify Dragonfly v2.0.2 allows `PUBLISH` inside a script (conformance suite runs on both; add a two-process ordering test that fails on the current code: N invalidations from two processes, assert the subscriber never sees a lower seq after a higher one).
2. N2: retry a failed `UNLINK` batch once on reconnect (keep the batch list on the link), or count orphans in `stats` and document the TTL bound in docs/cache-adapters.md. Pick retry if ≤ 40 lines; otherwise count + document.
3. Gates: `cd packages/cache-redis && bun run typecheck && BRUST_REDIS_REQUIRED=1 bun test` on redis + dragonfly, `bun test --timeout 180000 tests/server/cache-redis.test.ts`.

## Boundary
`packages/cache-redis/`, `tests/server/cache-redis.test.ts`, `docs/cache-adapters.md` (the Redis outage paragraph only).
