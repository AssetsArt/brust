# Cache adapters

A cache adapter adds an optional shared second tier behind brust's in-process page cache. It does two jobs:

1. **Store.** It keeps rendered pages where every process or isolate can read them.
2. **Broadcast.** It tells every other instance when `cache.invalidate(...)` ran, so they drop the stale entries.

An adapter is a plain TypeScript object. brust ships adapters for Redis, Dragonfly, Cloudflare KV and Cloudflare Durable Objects, and you can write your own. With no `[cache]` table in `brust.toml`, nothing here is active: behaviour and bytes are the same as without this feature.

## 1. The two tiers

```
request -> tier 1: in-process cache (microseconds)  --hit-->  200, x-brust-cache: HIT
              | miss (cacheable route, no bypass, no Set-Cookie)
              v
           tier 2: adapter store.get(key)  --hit-->  copied into tier 1, 200, x-brust-cache: HIT-L2
              | miss, timeout or error
              v
           loader -> jobs -> render -> tier 1 insert -> tier 2 store.set (in the background)
```

- **Tier 1** is always there: the Rust cache of the process (native) or of the isolate (Workers). The adapter is never called on a tier-1 hit.
- **Tier 2** exists only with an adapter that has a `store`. Only rendered page bodies are shared. Job results stay in tier 1. A `key` invalidation (job user keys) is broadcast, but the store ignores it.
- A `cache.invalidate(...)` call clears tier 1 of the process that ran it at once. The adapter then deletes the shared entries and broadcasts the event. Other instances replay it into their own tier 1.

## 2. When to use one

Use an adapter when:
- you run several brust processes or hosts and a mutation must show up on all of them quickly;
- you run on Cloudflare Workers, where every isolate has its own tier 1 and `cache.invalidate` is isolate-local (see [brust on Cloudflare Workers](./cloudflare.md), "Caching on Workers");
- renders are expensive and you want a warm shared cache after a restart.

Do not use one for a single native process: tier 1 already does the job, and a miss then pays an extra round trip.

An adapter never makes a request fail. A `get` that errors or exceeds `get_timeout_ms` counts as a tier-2 miss and the page renders normally.

## 3. Configuration

```toml
[cache]
adapter = "custom"             # redis | dragonfly | cloudflare-kv | cloudflare-do | custom
module = "lib/cache.ts"        # custom only: a file inside the app
broadcast = "cloudflare-do"    # optional: take the broadcast from another built-in adapter
namespace = "my-app"           # default: package.json "name", else "brust"
get_timeout_ms = 50            # 1..1000; default 50 on native, 100 on Workers
max_body_bytes = 1048576       # 1..67108864; larger pages are not written to tier 2
epoch_interval_ms = 1000       # 250..60000; pull broadcasts only (Workers)

[cache.options]                # passed to a custom adapter's factory
```

| Key | Default | Meaning |
|---|---|---|
| `adapter` | none (no tier 2) | One of the five names. Required when `[cache]` exists. |
| `module` | | `custom` only. The default export is a `CacheAdapter` or a factory `(options) => CacheAdapter`. A built-in adapter with `module` is a build error. |
| `broadcast` | | A built-in name. The store comes from `adapter`, the broadcast from this one (for example KV store plus Durable Object broadcast). |
| `namespace` | package name | `1..64` characters from `A-Za-z0-9@._/-`. Shared entries are scoped by it. |
| `get_timeout_ms` | 50 / 100 | The most a request waits for tier 2. |
| `max_body_bytes` | 1048576 | Bodies above it are not written. |
| `epoch_interval_ms` | 1000 | How often an isolate asks a pull broadcast for new events, at most. Lower means fresher and costlier (section 8). |
| `[cache.redis]`, `[cache.cloudflare]` | | Options of the built-ins. See sections 5 and 6. |
| `[cache.options]` | | Options of a `custom` adapter. |

Rules the build enforces:
- Unknown keys are an error.
- Keys of every shared entry include a **build id**, a hash of your manifest, templates, `jobs.js` and `actions.js`. A deploy therefore starts with an empty tier 2; old entries expire by their TTL. Plan for a cold cache after each deploy.
- A built-in adapter is an opt-in package. If it is not installed the build says so, for example `adapter "redis" needs @brust/cache-redis (bun add @brust/cache-redis)`.
- `env:NAME` values in a built-in's option table are read from the process environment at start (native). A missing variable stops the start and names the variable, never its value. On `--target cloudflare`, an `env:` value is a build error: use a binding. Options of a `custom` adapter are passed as written; read the environment yourself.
- Native accepts **push** broadcasts only. Workers accept **pull** broadcasts only.

### Runtimes

| | Native (`brust start`) | Workers |
|---|---|---|
| Where the adapter runs | in every Bun worker | in the Worker (bundled into `brust-app.js`) |
| Broadcast received by | worker 0 of each process | each isolate, by polling |
| Write to tier 2 | background; dropped when no worker is free | `waitUntil`, after the response |

## 4. Writing your own adapter

Import the types from `@brust/core/cache-adapter`. That module has no `bun` import, so it bundles into a Worker.

```ts
export interface CacheAdapter {
  readonly name: string
  readonly runtimes: ReadonlyArray<'bun' | 'workers'>
  store?: CacheStore
  broadcast?: CacheBroadcast
  init?(ctx: { namespace: string; buildId: string; runtime: 'bun' | 'workers'; workerId: number }): Promise<void>
  close?(): Promise<void>
}
```

An adapter needs a `store`, a `broadcast`, or both.

**Store** (shared page bodies):

```ts
interface CacheStore {
  get(key: string): Promise<{ page: StoredPage | null; stamp: number | null; entryStamp: number | null; storedAt: number | null }>
  set(key: string, page: StoredPage, meta: { ttlMs: number; tags: string[]; method: string; path: string; stamp: number | null }): Promise<boolean>
  invalidate(args: InvalidateArgs): Promise<void>
  readonly maxBodyBytes: number
}
interface StoredPage { status: number; headers: [string, string][]; body: Uint8Array }   // identity body
```

- `get` returns the page or `null`. `stamp` is the broadcast sequence number *now*; `set` later passes it back as `meta.stamp`.
- `set` returns `false` to refuse a write. A store that can do atomic writes **must** refuse when `meta.stamp` is older than an invalidation of one of `meta.tags` or of `meta.method meta.path`. This stops a page rendered before an invalidation from being stored after it. A store that cannot (a plain key-value service) returns `null` stamps and its writes are unguarded: stale entries then live up to their TTL.
- `invalidate` deletes by tag or by path. It ignores `key`. Record the invalidation *before* deleting, so a racing stale `set` is refused even before the broadcast.
- Bodies are binary. Preserve every byte value, and the order and repeats of headers.

**Broadcast** (invalidation events). Provide exactly one of `subscribe` or `since`:

```ts
interface CacheBroadcast {
  publish(args: InvalidateArgs, origin: string): Promise<number>   // resolves to the sequence number assigned
  subscribe?(on: (e: InvalidationEvent) => void, onGap: () => void): Promise<() => Promise<void>>   // push (native)
  since?(seq: number): Promise<{ gen: string; seq: number; behind: boolean; events: InvalidationEvent[] }>   // pull (Workers)
}
interface InvalidationEvent { seq: number; origin: string; args: InvalidateArgs }
```

- Every `stamp`, `entryStamp` and event `seq` is a number in **one** sequence space, the broadcast's.
- Push: call `on` in order, and call `onGap` whenever delivery may have lost an event; brust then clears tier 1.
- Pull: `gen` identifies the broadcast's history. If it changes, or `behind` is true, brust clears tier 1.
- brust skips events whose `origin` is its own: it already cleared its tier 1.

**Minimal custom example.** A store-only adapter over an HTTP key-value service. It works on both runtimes, has no broadcast, and so does not guard writes:

```ts
// lib/cache.ts
import { defineCacheAdapter, type StoredPage } from '@brust/core/cache-adapter'

export default defineCacheAdapter((opts) => {
  const base = String(opts.baseUrl)
  const token = String(opts.token)
  const call = (path: string, init: RequestInit = {}) =>
    fetch(base + path, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } })
  return {
    name: 'http-kv',
    runtimes: ['bun', 'workers'],
    store: {
      maxBodyBytes: 1_048_576,
      async get(key) {
        const r = await call(`/get/${encodeURIComponent(key)}`)
        if (r.status === 404) return { page: null, stamp: null, entryStamp: null, storedAt: null }
        const j = (await r.json()) as { status: number; headers: [string, string][]; body: string; storedAt: number }
        const page: StoredPage = { status: j.status, headers: j.headers, body: Uint8Array.from(atob(j.body), (c) => c.charCodeAt(0)) }
        return { page, stamp: null, entryStamp: null, storedAt: j.storedAt }
      },
      async set(key, page, meta) {
        const body = btoa(String.fromCharCode(...page.body))
        const r = await call(`/set/${encodeURIComponent(key)}?ttl=${Math.ceil(meta.ttlMs / 1000)}`, {
          method: 'POST',
          body: JSON.stringify({ status: page.status, headers: page.headers, body, storedAt: Date.now() }),
        })
        return r.ok
      },
      async invalidate() {
        // A service with no tag index cannot delete by tag. Entries then expire by their TTL.
      },
    },
  }
})
```

```toml
[cache]
adapter = "custom"
module = "lib/cache.ts"

[cache.options]
baseUrl = "https://kv.example.com"
token = "set in the environment and read there, not written in brust.toml"
```

`String.fromCharCode(...bytes)` is fine for the small page bodies in this sketch; chunk it for large ones. This sketch skips error handling: a thrown error is counted and treated as a miss.

Test your adapter with the conformance suite brust uses for its own adapters:

```ts
import { runConformance } from '@brust/core/cache-adapter/conformance'
// bun:test cases: binary-safe bodies, header order, TTL expiry, tag and path invalidation,
// the stale-write guard, push/pull delivery, gaps. Pass the capabilities your adapter claims.
runConformance(() => myAdapter(), { push: true, guard: true })
```

`@brust/core/cache-adapter` also exports `memoryAdapter`, the reference implementation. It shares nothing across processes, so it is for tests, not production.

## 5. Redis and Dragonfly

Package `@brust/cache-redis` (`bun add @brust/cache-redis`). One implementation serves both servers: `adapter = "redis"` or `adapter = "dragonfly"`. It uses Bun's built-in `RedisClient`, so it adds no npm dependency. It needs Bun 1.2.23 or newer and a Redis-compatible server 7.2 or newer. Bun's Redis pub/sub is still marked experimental by Bun; the adapter turns any lost message into a tier-1 clear rather than a stale page (below).

Bun only. It does not run on Workers, because a Worker has no TCP client the adapter can rely on. On Workers, use a custom adapter over an HTTP-based Redis service.

```toml
[cache]
adapter = "redis"              # or "dragonfly"
namespace = "my-app"

[cache.redis]
url = "env:REDIS_URL"          # always env:NAME; a literal URL is a build error
```

Run the app with `REDIS_URL` set, for example `rediss://user:password@host:6380/0`. Credentials live only inside the URL. The adapter's log lines show `host:port` and never the password.

### Options (`[cache.redis]`)

| Key | Default | Meaning |
|---|---|---|
| `url` | required | `redis://`, `rediss://`, `redis+tls://` or `redis+unix://`. Must be written as `env:NAME`. If the variable is unset the start fails and names the variable. |
| `tls` | `false` | `true`, `false`, or a table with `reject_unauthorized`, `server_name`, `ca_file` (a path to a PEM file, read at start). |
| `connect_timeout_ms` | 2000 | `100..60000`. One bounded connect at start. |
| `max_body_bytes` | 1048576 | `1..67108864`. Larger pages are not stored. |
| `marker_ttl_ms` | 86400000 | `60000..604800000`. How long an invalidation marker is remembered; it should be longer than your longest page TTL. |
| `unlink_batch` | 500 | `1..10000`. Pages deleted per `UNLINK` after an invalidation. |
| `reconnect_min_ms` | 100 | `10..60000`. First reconnect delay. |
| `reconnect_max_ms` | 5000 | `10..600000`. Cap of the exponential backoff (plus or minus 20% jitter). |

An unknown key stops the start with `cache-redis: unknown option "<key>"`.

### What it keeps in the server

Every key of a namespace carries the hash tag `{brust:<namespace>}`, so the scripts also work on Redis Cluster (all keys in one slot).

| Key | Holds |
|---|---|
| `{brust:ns}:page:<key>` | One page: a small header and the identity body, expiring with the page TTL. The key includes the build id. |
| `{brust:ns}:tag:<tag>`, `{brust:ns}:path:<METHOD> <path>` | Sets of the page keys under a tag or a path. |
| `{brust:ns}:inval:tag:<tag>`, `{brust:ns}:inval:path:<METHOD> <path>` | The sequence number of the last invalidation of that name, kept `marker_ttl_ms`. |
| `{brust:ns}:seq` | The invalidation counter. This is the stamp. |
| `{brust:ns}:stage:<id>` | A 30-second staging key used while writing a page. |
| channel `brust:<ns>:inval` | Pub/sub channel for invalidation events. |

Only page keys are scoped by build id. The index sets, markers, counter and channel are shared by all builds, so a rolling deploy keeps invalidating across old and new instances.

### Guard and invalidation

- **A stale write is refused exactly.** `get` returns the counter as the stamp. `set` runs a Lua script that checks the invalidation markers of the page's tags and of its `METHOD path`, and refuses (returns false) if any is newer than the stamp. A page rendered before an invalidation therefore cannot be stored after it, even if the two race.
- **Invalidate and publish are one script.** It increments the counter, raises the markers, drops the index sets and publishes `{seq, origin, args}` on the channel, all inside the script. Scripts run one at a time, so events reach subscribers in counter order even when several processes invalidate at once. The adapter then deletes the pages (`UNLINK`, in batches). Every script declares all its keys, as Dragonfly requires.
- **Receiving.** Worker 0 of each process holds the subscription and replays events into the process's tier 1. Events from the same process are skipped.

### Connections

Each Bun worker keeps one command connection. Worker 0 keeps one more for the subscription. A process with W workers therefore holds W + 1 connections to the server. Size `maxclients` for the number of processes times (W + 1).

### Outages and what tier 1 does

- If the server is unreachable at start, the app still starts: the adapter tries one bounded connect, logs a warning and keeps retrying in the background.
- While disconnected, commands fail at once; they are not queued. Tier-2 `get`/`set` failures count as `errors`, failed publishes as `publish_errors`, and pages keep being served from tier 1 and rendered on a miss. Logged failures are rate-limited (the first, then every 10th).
- After every re-subscribe the adapter reads the counter. If it moved beyond the last event this process saw, tier 1 is cleared once (`resets` +1), so an event missed during the outage cannot leave a stale page.

One limit you should know about:
- **Orphaned pages after a dropped `UNLINK` batch.** The index sets are deleted inside the script, but pages are deleted afterwards. If the connection drops in between, those pages have no index entry. The adapter keeps the failed batch (at most 64 batches of `unlink_batch` pages) and tries it once more when the command connection comes back; if that fails too, or the batch was not kept, the pages stay until their TTL. Instances that replayed the event reject them through the invalidation floor, so the cost is storage and an occasional extra render, not a stale page.

### Dragonfly

- Same package, `adapter = "dragonfly"`. It was run against Dragonfly v2.0.2 in brust's tests.
- Dragonfly requires every key a script touches to be declared; the adapter's scripts do.
- When running the container yourself, pass `--ulimit memlock=-1`.

## 6. Cloudflare KV and Durable Objects

Package `@brust/cache-cloudflare` (`bun add @brust/cache-cloudflare`). Workers only. It imports nothing from Bun. Three configurations:

| `[cache]` | What it is |
|---|---|
| `adapter = "cloudflare-kv"` | Pages in Workers KV. A store with no broadcast. |
| `adapter = "cloudflare-do"` | A Durable Object that carries invalidations (a pull broadcast). With `do_store = true` it also stores the pages, in 16 shard objects. |
| `adapter = "cloudflare-kv"` and `broadcast = "cloudflare-do"` | **The recommended pair.** KV holds the bodies and the Durable Object tells every isolate what was invalidated. |

```toml
[cache]
adapter = "cloudflare-kv"
broadcast = "cloudflare-do"
epoch_interval_ms = 5000

[cache.cloudflare]
kv_min_ttl_s = 300
```

### Bindings you declare

brust adds no binding. Declare them in your own `wrangler.jsonc`. The build checks the top level and every `env.*` block, and if something is missing it fails and prints this snippet:

```jsonc
{
  "kv_namespaces": [{ "binding": "BRUST_CACHE", "id": "<wrangler kv namespace create brust-cache>" }],
  "durable_objects": { "bindings": [{ "name": "BRUST_CACHE_DO", "class_name": "BrustCacheDO" }] },
  "migrations": [{ "tag": "brust-cache-v1", "new_sqlite_classes": ["BrustCacheDO"] }]
}
```

`kv_namespaces` is needed for KV and the pair. The `durable_objects` binding and the migration are needed for `cloudflare-do` and the pair. `BrustCacheDO` must be a SQLite-backed class (`new_sqlite_classes`, or an `exports` entry with `"storage": "sqlite"`). Create the KV namespace with `wrangler kv namespace create`.

When a Durable Object is configured, `brust build` also writes `dist/cf/worker/main.js`, a short generated file that re-exports the Worker and `BrustCacheDO` so Cloudflare can bind the class, and points `main` at it. Do not write your own. The build refuses if `@brust/core-cf` ever ships a `worker/main.js` itself.

### Options (`[cache.cloudflare]`)

| Key | Used by | Default | Meaning |
|---|---|---|---|
| `kv_binding` | KV, pair | `"BRUST_CACHE"` | Name of the KV binding. |
| `kv_min_ttl_s` | KV, pair | `300` | `0..31536000`. A route whose TTL is smaller is not written to KV (KV's own floor is 60 s). |
| `do_binding` | DO, pair | `"BRUST_CACHE_DO"` | Name of the Durable Object binding; its `class_name` must be `BrustCacheDO`. |
| `do_store` | `cloudflare-do` | `false` | `true` stores pages in 16 Durable Object shards. Ignored with the pair. |

An unknown key in this table is an error that names it. `env:` values are not allowed on this target.

**Caveat: `[cache.cloudflare]` is ignored for `adapter = "custom"`.** The build reads `[cache.redis]` and `[cache.cloudflare]` only for built-in adapters, and without a warning. A custom adapter that calls `kvAdapter({ binding, min_ttl_s })`, `doAdapter({ binding, store })` or `combine(kv, do)` itself (all exported by `@brust/cache-cloudflare`) must pass its options through `[cache.options]` or in code. Use the same `kvAdapter`/`doAdapter` option names as the programmatic form: `binding`, `min_ttl_s`, `store`.

**Caveat: migrations in `env` blocks.** The build accepts a `migrations` or `exports` declaration of the class at the top level for an `env.*` block. It has not been verified that `wrangler deploy --env <name>` applies a top-level `migrations` entry to that environment. If you deploy an `env`, declare the bindings and the migration inside that `env` block, and try `wrangler deploy --dry-run --env <name>` first.

### What each configuration guarantees

| Config | Store | Other isolates after `cache.invalidate` | A stale page served again? | Free-plan cost driver |
|---|---|---|---|---|
| `cloudflare-kv` alone | KV, unguarded | up to the page TTL (no broadcast) | **yes**, up to the TTL (at least 300 s by default) | 1 KV write per tier-1 miss |
| `cloudflare-do`, `do_store = false` | none (tier 1 only) | within `epoch_interval_ms` plus one round trip | no | 1 DO request per poll per isolate |
| `cloudflare-do`, `do_store = true` | DO shards, exact write guard | within `epoch_interval_ms` plus one round trip | no (the rows are deleted) | plus 1 DO request per tier-1 miss, about 18 per invalidation |
| KV + `broadcast = "cloudflare-do"` | KV, guarded by per-isolate floors | within `epoch_interval_ms` plus one round trip | no, once the isolate knows the invalidation | 1 KV write per miss plus the DO polls |

**KV alone never invalidates.** Tier-2 keys hash the route prefix, method, path and query, so KV cannot list the pages under a tag or a path without extra index writes. Use the pair unless a stale page for up to its TTL is acceptable.

**How the pair stays correct.** Each isolate keeps, for every tag and path, the sequence number of the last invalidation it knows. It seeds this from the Durable Object when it starts and after a restart, raises it from every event it polls, and raises it from its own invalidations. A KV page whose write stamp is older than the floor of its tags or path, or which has no stamp, is treated as a miss. A stale write from a lagging isolate can land in KV, but every isolate that knows the invalidation, including a new one, rejects it. The cost is an extra render, never a stale page.

### Things that behave in ways you should expect

- **KV can hide a fresh page for up to 60 s per location.** The adapter reads KV with a 60-second `cacheTtl`, and KV allows one write per second per key. After an invalidation, a hot page's new value may stay invisible at a location's KV cache for up to a minute. Each isolate there then misses (the old value is rejected by the floor) and renders the page itself, and its write may get a 429 (the adapter returns false). This is correct, but expect a burst of renders after invalidating a popular page.
- **Lagging stamps cost misses.** Writes are stamped with the sequence number this isolate last saw, which can trail the Durable Object by up to `epoch_interval_ms`. A page rendered right after a remote invalidation may be written below another isolate's floor and be rejected there: an extra miss, never a stale serve.
- **A Durable Object restart clears every isolate once.** The Durable Object keeps its counters and floors in SQLite storage, so sequence numbers never go backward. Its event ring is in memory and it takes a new generation id each time it starts, for example after a deploy or after being evicted when idle. Every isolate sees the new generation on its next poll and clears its tier 1 once (`resets` +1). That is the safe behaviour. Expect it after quiet periods.
- **KV is eventually consistent.** Local `wrangler dev` KV is strongly consistent, so the propagation lag is not covered by brust's local tests.
- **A KV write is skipped** when the same isolate wrote an identical page less than 60 seconds earlier.

## 7. Semantics per backend

What each backend gives (details in sections 5 and 6):

| | Redis / Dragonfly | KV alone | Durable Object | KV + Durable Object | Custom |
|---|---|---|---|---|---|
| Runs on | Bun | Workers | Workers | Workers | what `runtimes` says |
| Store | shared bodies, expire by TTL | shared bodies, long-TTL only | optional (`do_store`), 16 shards | KV bodies | optional |
| Stale-write guard | exact | none: a stale body can live up to its TTL | exact | floors in each isolate | whatever you implement |
| Broadcast | push, immediate | none | pull, ordered ring | pull, ordered ring | push or pull |
| Other instances after `cache.invalidate` | about pub/sub latency | up to the TTL | within about `epoch_interval_ms` plus one round trip | same | depends |
| On failure | fail-open; a gap clears tier 1 | fail-open | fail-open; a restart clears tier 1 once | fail-open | |

**KV is a long-TTL store, not an invalidation channel.** KV writes are visible in other locations "up to 60 seconds" later (source C9), and KV has no compare-and-set, so brust cannot refuse a stale write. The KV adapter therefore refuses to store pages with a TTL below 300 seconds by default, and the docs advise pairing it with the Durable Object broadcast (`broadcast = "cloudflare-do"`). Alone, a deleted page can still be read for a while from other locations.

A lost invalidation (publish failed, or the broadcast was down) leaves other instances stale for at most the page's TTL. Gaps the adapter can detect clear tier 1 instead. One blind spot on native: if the *last* event is lost and nothing follows it, no gap is seen until the next event, so the bound is the TTL.

## 8. Failure behaviour and `/_brust/cache/stats`

Everything on the request path has a budget and fails open:

| Operation | On the request path? | Budget | On failure |
|---|---|---|---|
| tier-1 probe | yes | microseconds | none |
| `store.get` (tier-1 miss) | yes | `get_timeout_ms` | tier-2 miss; no write follows |
| pull poll (`since`) | Workers: the first request after `epoch_interval_ms`, one at a time | 500 ms | serve tier 1; `poll_errors` +1 |
| `store.set` | no | native: dropped if no worker is free; Workers: `waitUntil` | counted, never an error to the client |
| `store.invalidate` and `publish` | no | | `publish_errors` +1; others stale up to the TTL |

A tier-2 hit answers with `x-brust-cache: HIT-L2`; a tier-1 hit stays `HIT`. A stored page's TTL is what is left of its original TTL, so a page never lives longer in total than its route's `ttl_seconds`.

With an adapter configured, `/_brust/cache/stats` gains an `l2` object. Without one, the JSON is unchanged. On Workers the path needs `[cloudflare] stats = true`, and the numbers are per isolate.

```json
"l2": { "adapter": "custom", "hits": 0, "misses": 0, "timeouts": 0, "errors": 0, "rejected_floor": 0,
        "sets": 0, "set_refused": 0, "set_dropped": 0, "set_oversize": 0, "published": 0, "publish_errors": 0,
        "received": 0, "skipped_own": 0, "resets": 0, "epoch_polls": 0, "poll_errors": 0 }
```

| Counter | Meaning |
|---|---|
| `hits`, `misses` | tier-2 lookups that found or did not find a valid page |
| `timeouts`, `errors` | lookups that exceeded `get_timeout_ms`, or failed |
| `rejected_floor` | pages found but discarded because an invalidation newer than the page was already seen (Workers) |
| `sets`, `set_refused`, `set_dropped`, `set_oversize` | writes done, refused by the store's guard, dropped for lack of a free worker, skipped for size |
| `published`, `publish_errors` | invalidations broadcast, and broadcasts that failed |
| `received`, `skipped_own` | events replayed into tier 1, and events skipped because this instance sent them |
| `resets` | times tier 1 was cleared because of a gap, a new `gen`, or falling behind |
| `epoch_polls`, `poll_errors` | pull polls made and failed |

## 9. Cost guidance

Prices and quotas were read from Cloudflare's pages on 2026-10-12 and change over time. Check them before you size.

**Durable Object requests.** The pull broadcast makes one DO request per poll, and only an isolate that is serving requests polls (idle isolates cost nothing). A continuously busy isolate polls `86,400,000 / epoch_interval_ms` times a day. Cloudflare's Free plan includes 100,000 DO requests per day and 13,000 GB-s per day, and past a Free limit "further operations of that type will fail with an error". Paid includes 1 million requests per month, then $0.15 per million (source C7).

| `epoch_interval_ms` | polls per day per busy isolate | Free: busy isolates the daily quota covers | Paid: 10 busy isolates, 30 days | Worst-case staleness |
|---|---|---|---|---|
| 250 (minimum) | 345,600 | none (one isolate exceeds it) | 103.68 million requests, about $15.40 | about 0.25 s plus one round trip |
| **1000 (default)** | 86,400 | one (86% of the quota) | 25.92 million, about $3.74 | about 1 s plus one round trip |
| 5000 | 17,280 | about 5 | 5.18 million, about $0.63 | about 5 s plus one round trip |
| 60000 (maximum) | 1,440 | about 69 | 0.43 million, inside the included 1 million | about 60 s plus one round trip |

The Paid column is overage only: `(requests - 1 million) x $0.15 per million`; it excludes the plan's minimum charge and other usage. A DO kept active by polls uses about 11,000 GB-s a day at 128 MB, inside the Free 13,000.

On the Free plan with steady traffic, set `epoch_interval_ms` to 5000 or more. When the quota runs out, polls fail, the adapter fails open and invalidation falls back to the TTL, and `poll_errors` rises. One DO object serves about 1,000 requests per second as a soft limit (source C10), which is roughly 1,000 busy isolates at 1 s.

**KV.** Free allows 1,000 writes and 100,000 reads per day. Paid includes 1 million writes and 10 million reads per month, then $5.00 and $0.50 per million (source C8). Write-through costs one KV write per tier-2 miss of a page that is long-lived enough to be stored, so the Free write quota is the binding limit: it is why the default minimum TTL is 300 s.

**Redis and Dragonfly.** You pay for your own server. Each brust process opens one connection per worker plus one for the subscription (section 5).

## 10. What v1 does not do

- **No stampede protection.** When a page expires, every instance that misses renders it. There is no cross-instance lock or render coalescing. A process-local single-flight is a possible follow-up.
- **No entry signing.** The store is trusted. Entries are scoped by namespace and build id only. If other parties can write to your Redis, they can put pages into your cache. Restrict access to it.
- **No sharing of job results.** Only page bodies are shared.
- **No streaming bodies.**
- **No Redis on Workers.** There is no TCP client a Worker can rely on. Use a custom adapter over an HTTP-based service.
- **No KV or Durable Object adapter on native.**

## Sources

All fetched 2026-10-12.

| Id | Page |
|---|---|
| C7 | https://developers.cloudflare.com/durable-objects/platform/pricing/ |
| C8 | https://developers.cloudflare.com/kv/platform/pricing/ (also https://developers.cloudflare.com/kv/platform/limits/) |
| C9 | https://developers.cloudflare.com/kv/api/write-key-value-pairs/ |
| C10 | https://developers.cloudflare.com/durable-objects/platform/limits/ |
