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

<!-- pending: lane B (cache-redis). Fill from that lane's merged package: config block and option table, key schema, write-guard semantics, reconnect and gap behaviour, Dragonfly notes, TLS and auth, Bun version, connections per process. -->

Summary of what the design promises, to be confirmed against the merged package: shared page bodies, an exact stale-write guard, and an immediate push broadcast to every subscribed process. Bun only. Not available on Workers (use a custom adapter, for example an HTTP-based Redis service).

## 6. Cloudflare KV and Durable Objects

<!-- pending: lane C (cache-cloudflare). Fill from that lane's merged package: option tables, the required wrangler bindings and migration snippet, the generated worker/main.js re-export, the DO epoch and do_store designs, per-day cost drivers. -->

Both are Workers-only and are opt-in packages, so the Workers runtime itself still depends on nothing but Workers. The bindings are declared in your own `wrangler.jsonc`; the build checks them and prints the snippet that is missing.

## 7. Semantics per backend

What each backend gives, from the design (confirmed in the pages above once those lanes merge):

| | Redis / Dragonfly | Cloudflare KV | Cloudflare Durable Object | Custom |
|---|---|---|---|---|
| Runs on | Bun | Workers | Workers | what `runtimes` says |
| Store | shared bodies, expire by TTL | shared bodies, long-TTL only | optional, in DO storage | optional |
| Stale-write guard | exact | none: a stale body can live up to its TTL | exact | whatever you implement |
| Broadcast | push, immediate | none you can rely on | pull, ordered ring | push or pull |
| Other instances after `cache.invalidate` | about pub/sub latency | up to the TTL when used alone | within about `epoch_interval_ms` plus one round trip | depends |
| On failure | fail-open; a gap clears tier 1 | fail-open | fail-open; a restart changes `gen` and clears tier 1 once | |

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

**Redis and Dragonfly.** You pay for your own server. Each brust process opens one connection per worker plus one for the subscription (to be confirmed in section 5).

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
