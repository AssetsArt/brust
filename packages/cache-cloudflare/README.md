# @brust/cache-cloudflare

Cloudflare Workers adapters for brust's shared second cache tier (`[cache]` in `brust.toml`, `brust build --target cloudflare`):

- **`cloudflare-kv`**: pages in Workers KV (a store, no broadcast).
- **`cloudflare-do`**: invalidations through a Durable Object (a pull broadcast), optionally also the page store (`do_store = true`, 16 shards).
- **`cloudflare-kv` + `broadcast = "cloudflare-do"`**: the recommended pair (`combine`). KV holds the bodies, the Durable Object tells every isolate what was invalidated.

Workers only (`runtimes: ['workers']`). No `bun`/`bun:*` import. Peer dependency: `@brust/core`.

```toml
[cache]
adapter = "cloudflare-kv"
broadcast = "cloudflare-do"
epoch_interval_ms = 5000

[cache.cloudflare]
kv_min_ttl_s = 300
```

## Wrangler bindings (you declare them; brust never adds them)

`brust build --target cloudflare` checks the top level and every `env.*` block of your wrangler config and fails with this snippet when something is missing:

```jsonc
{
  "kv_namespaces": [{ "binding": "BRUST_CACHE", "id": "<wrangler kv namespace create brust-cache>" }],
  "durable_objects": { "bindings": [{ "name": "BRUST_CACHE_DO", "class_name": "BrustCacheDO" }] },
  "migrations": [{ "tag": "brust-cache-v1", "new_sqlite_classes": ["BrustCacheDO"] }]
}
```

`BrustCacheDO` must be a SQLite-backed class (`new_sqlite_classes`, or `exports.BrustCacheDO = { "type": "durable-object", "storage": "sqlite" }`). `brust build` writes `dist/cf/worker/main.js`, which re-exports it; do not write your own.

## Options (`[cache.cloudflare]`)

| key | used by | default | rule |
|---|---|---|---|
| `kv_binding` | KV, pair | `"BRUST_CACHE"` | a binding name in `kv_namespaces` |
| `kv_min_ttl_s` | KV, pair | `300` | `0..=31536000`; a route with a smaller ttl is not written to KV (KV's own floor is 60 s) |
| `do_binding` | DO, pair | `"BRUST_CACHE_DO"` | a `durable_objects` binding with `class_name "BrustCacheDO"` |
| `do_store` | DO | `false` | `true` = bodies in 16 Durable Object shards (ignored with the pair) |

Programmatic forms (for `adapter = "custom"`): `kvAdapter({ binding?, min_ttl_s? })`, `doAdapter({ binding?, store? })`, `combine(kv, do)`. An unknown key is a `TypeError` naming it.

## What each configuration guarantees

| config | store | other isolates after `cache.invalidate` | stale body re-served? | Free-plan cost driver |
|---|---|---|---|---|
| `cloudflare-kv` alone | KV, unguarded | up to the ttl (no broadcast) | **yes**, up to the ttl (at least 300 s) | 1 KV write per MISS |
| `cloudflare-do`, `do_store = false` | none (tier 1 only) | `epoch_interval_ms` + RTT | no | 1 DO request per poll per isolate |
| `cloudflare-do`, `do_store = true` | DO shards, exact write guard | `epoch_interval_ms` + RTT | no (rows are deleted) | + 1 DO request per tier-1 miss, + 18 per invalidation |
| `cloudflare-kv` + `broadcast = "cloudflare-do"` | KV, floor-guarded | `epoch_interval_ms` + RTT | no once the floor is known; KV lag is hidden by each entry's `entryStamp` | KV write per MISS + DO polls |

**KV alone never invalidates.** An L2 key hashes prefix, method, path and query, so a tag or a path cannot be enumerated in KV without extra index writes. Pair it with the Durable Object broadcast unless a stale page for up to its ttl is fine.

With the pair, each isolate keeps invalidation floors in JS (seeded from the Durable Object on first contact and after a generation change), so a freshly started isolate never serves a KV body that was invalidated before it started.

## Free-plan numbers

| driver | per day | Free quota | note |
|---|---|---|---|
| epoch polls, 1 busy isolate, `epoch_interval_ms` 1000 | 86,400 DO requests | 100,000 DO requests | 86 % for ONE isolate |
| same at 5000 ms | 17,280 | 100,000 | about 5 busy isolates |
| same at 60000 ms | 1,440 | 100,000 | about 69 isolates; staleness about 60 s |
| `do_store` tier-1 miss | 1 DO request each | 100,000 | plus rows read |
| invalidation | 1 DO request (18 with `do_store`) + at most 5 rows written | 100,000 rows written | |
| KV write-through | 1 KV write per MISS of a ttl >= 300 s page | 1,000 writes | the binding constraint on Free |
| KV read-through | 1 KV read per tier-1 miss | 100,000 reads | |

On Free, set `epoch_interval_ms >= 5000` and prefer KV + DO over `do_store`. A `do_store` invalidation issues about 18 subrequests inside the action's invocation (Free allows 50); an action that already makes more than 30 will see shard invalidations fail.

## Behaviour notes

- The Durable Object persists its `seq` and the name-to-seq floors in its SQLite storage, so seqs never regress across a restart. The event ring is in memory and `gen` is new on every construction, so every isolate clears tier 1 once after a restart.
- A KV write is skipped when this isolate wrote an identical page less than 60 s ago (KV allows one write per second per key).
- KV is eventually consistent (up to about 60 s across locations). Local `wrangler dev` KV is strongly consistent, so propagation lag is not covered by the test suite.
