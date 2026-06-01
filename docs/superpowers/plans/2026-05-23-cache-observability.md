# Cache observability + capacity config

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the LRU cache's `hits`/`misses` counters via a native HTTP endpoint `/_brust/cache/stats` (JSON). Make the cache capacity configurable via a new `[cache]` section in `brust.toml` (default stays 1000 entries).

**Architecture:** No new dependencies. The existing `LruCache` already tracks `hits`/`misses` as `AtomicU64` (currently `#[allow(dead_code)]` — this plan consumes them). Add a `LruCache::stats() -> CacheStats` method and a `LruCache::resize(n)` wrapper. `handle_conn` gains a `/_brust/cache/stats` short-circuit (alongside `/ping`) that serializes `CacheStats` to JSON and writes a response — no worker dispatch. `runtime/config.ts` extracts `[cache].max_entries` and surfaces it on `BrustConfig`. `runtime/index.ts` exposes a new `brust.configureCache({ maxEntries })` method that calls a new napi export `configure_cache(max_entries)`. The example app calls `configureCache` before `serve` when the config provides a value.

**Tech Stack:** Rust 2024, TypeScript 5, no new crates. `lru::LruCache::resize` is available since 0.7 (we're on 0.12).

**Spec source:** LRU Cache plan S"Risks / caveats" and S"Out of scope" — both flagged stats endpoint + `[cache]` TOML as deferred follow-ups. This plan ships both.

---

## Decisions

- **Stats endpoint path:** `/_brust/cache/stats`. The `/_brust/*` prefix is the framework's reserved namespace (already documented in architecture.md as the home of agentic/action endpoints). Native-only route — bypasses the worker pool, lives in Rust.
- **Stats payload:** `{ hits, misses, len, capacity }` as JSON. `len` = current entry count; `capacity` = max entries.
- **Capacity config knob:** `[cache] max_entries = N` in `brust.toml`. Plumbs through `BrustConfig.cacheMaxEntries: number | undefined`. The TS facade calls `brust.configureCache({ maxEntries })` BEFORE `brust.serve(...)`. Calling it after `serve` is allowed (the cache is process-global) but doesn't drop existing entries beyond the new cap — `lru::LruCache::resize` evicts excess LRU entries.
- **Default capacity:** unchanged at 1000. If `[cache]` is absent or `max_entries` is omitted, the existing default holds.
- **No explicit `cache: false` field for routes.** Omission already opts out. Adding `false` as a literal value to the TS type just complicates without benefit.

### Files this plan touches

| File | Change |
|---|---|
| `src/cache.rs` | Add `CacheStats` struct (serde Serialize), `stats()` method, `resize(NonZeroUsize)` method. Remove `#[allow(dead_code)]` from `hits`/`misses` (now consumed). |
| `src/lib.rs` | New napi export `configure_cache(max_entries: u32)`. |
| `src/server.rs` | `handle_conn` gains a `/_brust/cache/stats` short-circuit that calls `cache.stats()`, serializes to JSON via serde_json, and writes a 200 response. Placed alongside `/ping`. |
| `runtime/config.ts` | `BrustConfig` gains optional `cacheMaxEntries`. `loadConfig` reads `[cache].max_entries`. |
| `runtime/index.ts` | New `brust.configureCache({ maxEntries })` method. |
| `example/hello-world/index.ts` | If `loadConfig` returned a `cacheMaxEntries`, call `brust.configureCache(...)` before `serve`. |
| `tests/integration.test.ts` | One new test: hit `/cache-test` twice, then hit `/_brust/cache/stats`, assert hits ≥ 1 and misses ≥ 1. |
| `architecture.md` | SCache section + SConfiguration section + SStatus update. |

`src/routes.rs`, `src/pool.rs`, `src/http.rs`, `runtime/routes.ts`, `Cargo.toml`: untouched.

---

### Task 1: Baseline verification

**Files:** none

- [ ] `cd /Users/detoro/code/brust && cargo build && bun run test`
  Expected: 1 warning (pre-existing), `7 pass, 0 fail`.
- [ ] Skip commit.

---

### Task 2: Implement stats + resize on the Rust cache

**Files:**
- Modify: `src/cache.rs`

- [ ] **Step 1:** Open `src/cache.rs`. Add `Serialize` to the serde import:

```rust
use serde::{Deserialize, Serialize};
```

- [ ] **Step 2:** Add the `CacheStats` struct after the existing `CachedEntry` definition (above the `LruCache` struct):

```rust
/// Stats snapshot. Serialized to JSON by the /_brust/cache/stats native route.
#[derive(Debug, Clone, Serialize)]
pub struct CacheStats {
    pub hits: u64,
    pub misses: u64,
    pub len: usize,
    pub capacity: usize,
}
```

- [ ] **Step 3:** Remove the `#[allow(dead_code)]` attributes from `hits` and `misses` on `LruCache`. The two atomics are now consumed by `stats()`.

- [ ] **Step 4:** Add the `stats` and `resize` methods to `impl LruCache`. Place them after the existing `insert`:

```rust
    pub fn stats(&self) -> CacheStats {
        let guard = self.inner.lock();
        CacheStats {
            hits: self.hits.load(Ordering::Relaxed),
            misses: self.misses.load(Ordering::Relaxed),
            len: guard.len(),
            capacity: guard.cap().get(),
        }
    }

    /// Resize the LRU. If shrinking below current length, excess LRU entries
    /// are evicted. Safe to call at any time; no-op if `max == capacity`.
    pub fn resize(&self, max: NonZeroUsize) {
        self.inner.lock().resize(max);
    }
```

(`NonZeroUsize` is already imported at the top of the file.)

- [ ] **Step 5:** `cargo build`. Expected: clean, 1 pre-existing warning. The `hits`/`misses` dead-code warnings disappear (they're now read by `stats()`).

- [ ] **Step 6:** Skip commit (combined with Task 3).

---

### Task 3: Expose `configure_cache` napi + `/_brust/cache/stats` route

**Files:**
- Modify: `src/lib.rs`
- Modify: `src/server.rs`

- [ ] **Step 1:** In `src/lib.rs`, add the napi export. Place after the existing `register_routes`:

```rust
#[napi]
pub fn configure_cache(max_entries: u32) -> NapiResult<()> {
    use std::num::NonZeroUsize;
    let n = NonZeroUsize::new(max_entries as usize)
        .ok_or_else(|| napi::Error::from_reason("cache max_entries must be > 0"))?;
    state().cache.resize(n);
    Ok(())
}
```

- [ ] **Step 2:** In `src/server.rs`, add the stats route. Find the `/ping` short-circuit:

```rust
        // Native-only route: bypass napi pool so benchmarks can isolate TCP+HTTP cost from React SSR cost.
        if path == "/ping" {
            let bytes = http::build_response(200, "text/plain", b"pong\n".to_vec());
            if s.write_all(bytes).await.is_err() {
                return;
            }
            continue;
        }
```

Add a sibling short-circuit immediately below it:

```rust
        // Native-only route: cache observability. JSON of hits/misses/len/capacity.
        if path == "/_brust/cache/stats" {
            let stats = cache.stats();
            let json = serde_json::to_string(&stats).unwrap_or_else(|_| String::from("{}"));
            let bytes = http::build_response(200, "application/json", json.into_bytes());
            if s.write_all(bytes).await.is_err() {
                return;
            }
            continue;
        }
```

- [ ] **Step 3:** `cargo build`. Expected: clean compile, 1 warning.

- [ ] **Step 4:** `cd runtime && bun run build:debug && cd -`.

- [ ] **Step 5:** `bun run test`. Expected: `7 pass, 0 fail` (no behavior change for existing tests — stats route hasn't been tested yet).

- [ ] **Step 6:** Quick manual verification:

```bash
bun run dev &
sleep 1
curl -s http://127.0.0.1:3000/_brust/cache/stats
curl -s http://127.0.0.1:3000/cache-test > /dev/null
curl -s http://127.0.0.1:3000/cache-test > /dev/null
curl -s http://127.0.0.1:3000/_brust/cache/stats
kill %1
```

Expected: first stats call shows `{"hits":0,"misses":0,"len":0,"capacity":1000}`. After two `/cache-test` requests (first miss + insert, second hit), stats should show `hits:1, misses:1, len:1, capacity:1000`.

- [ ] **Step 7:** Skip commit (combined with Task 5).

---

### Task 4: Wire `[cache].max_entries` through config

**Files:**
- Modify: `runtime/config.ts`
- Modify: `runtime/index.ts`
- Modify: `example/hello-world/index.ts`

- [ ] **Step 1:** Open `runtime/config.ts`. Extend the `BrustConfig` interface:

```typescript
export interface BrustConfig {
  /** TCP port to bind on. Default 3000. */
  port: number
  /** Bun Worker count for render dispatch. Default floor(availableParallelism * 1.8). */
  workers: number
  /** Cache capacity (entries). Undefined → Rust default of 1000. */
  cacheMaxEntries?: number
}
```

Add `[cache]` parsing in `extractFromToml`. After the existing `if ('workers' in root) { ... }` block, append:

```typescript
  if ('cache' in root) {
    const cache = root.cache
    if (cache === null || typeof cache !== 'object') {
      throw new BrustConfigError(`${file}: [cache] must be a table`, file)
    }
    const maxEntries = (cache as Record<string, unknown>).max_entries
    if (maxEntries !== undefined) {
      if (typeof maxEntries !== 'number' || !Number.isInteger(maxEntries) || maxEntries < 1) {
        throw new BrustConfigError(
          `${file}: cache.max_entries must be a positive integer (got ${JSON.stringify(maxEntries)})`,
          file,
        )
      }
      out.cacheMaxEntries = maxEntries
    }
  }
```

Update the function return at the bottom of `loadConfig`:

```typescript
  return { port, workers, cacheMaxEntries: fromToml.cacheMaxEntries }
}
```

(Env-only path doesn't override cache. We could add `BRUST_CACHE_MAX_ENTRIES` for consistency but it's not in the plan — defer.)

- [ ] **Step 2:** Open `runtime/index.ts`. Add `configureCache` to the `brust` object, between `registerRoutes` and `registerRenderer`:

```typescript
  /** Set the response cache capacity (entries). Default is 1000.
   * Safe to call at any time; if shrinking below current size, excess
   * LRU entries are evicted. */
  configureCache(opts: { maxEntries: number }): void {
    ; (native as any).configureCache(opts.maxEntries)
  },
```

- [ ] **Step 3:** Open `example/hello-world/index.ts`. Find the existing `if (!isWorker)` branch:

```typescript
if (!isWorker) {
  const { port, workers } = await loadConfig()
  console.log(`[brust] main: spawning ${workers} worker threads`)

  brust.registerRoutes(routes)

  await brust.serve({ ... })
```

Update destructure + call:

```typescript
if (!isWorker) {
  const { port, workers, cacheMaxEntries } = await loadConfig()
  console.log(`[brust] main: spawning ${workers} worker threads`)

  if (cacheMaxEntries !== undefined) {
    brust.configureCache({ maxEntries: cacheMaxEntries })
  }
  brust.registerRoutes(routes)

  await brust.serve({ ... })
```

- [ ] **Step 4:** `cd runtime && bun run build:debug && cd -` (to regenerate the `.d.ts` for the new `configureCache` napi export).

- [ ] **Step 5:** Verify `runtime/index.d.ts` now exports `configureCache`. The auto-generated `.d.ts` is gitignored, but the type must be present at runtime resolution time.

- [ ] **Step 6:** Skip commit (combined with Task 5).

---

### Task 5: Add the integration test + commit everything

**Files:**
- Modify: `tests/integration.test.ts`

- [ ] **Step 1:** Append a new test at the end of `tests/integration.test.ts`, before the `readPortLine` helper:

```typescript
test('cache stats endpoint reflects hits and misses', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: {
      ...process.env,
      BRUST_PORT: '38151',
      BRUST_WORKERS: '1',
      RUST_LOG: 'brust=info',
    },
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    // Initially zero.
    const r0 = await fetch(`http://127.0.0.1:${port}/_brust/cache/stats`)
    expect(r0.status).toBe(200)
    expect(r0.headers.get('content-type')).toBe('application/json')
    const s0 = await r0.json() as { hits: number, misses: number, len: number, capacity: number }
    expect(s0.hits).toBe(0)
    expect(s0.misses).toBe(0)
    expect(s0.len).toBe(0)
    expect(s0.capacity).toBe(1000)

    // First /cache-test = miss + insert.
    await fetch(`http://127.0.0.1:${port}/cache-test`)
    // Second = hit.
    await fetch(`http://127.0.0.1:${port}/cache-test`)

    const r1 = await fetch(`http://127.0.0.1:${port}/_brust/cache/stats`)
    const s1 = await r1.json() as { hits: number, misses: number, len: number, capacity: number }
    expect(s1.hits).toBeGreaterThanOrEqual(1)
    expect(s1.misses).toBeGreaterThanOrEqual(1)
    expect(s1.len).toBeGreaterThanOrEqual(1)
    expect(s1.capacity).toBe(1000)
  } finally {
    proc.kill('SIGINT')
    const exit = await proc.exited
    expect(exit).toBe(0)
  }
}, 15_000)
```

- [ ] **Step 2:** `bun run test`. Expected: `8 pass, 0 fail`. If `s0.capacity` is something other than 1000 — the default isn't being applied; check `LruCache::stats()` uses `guard.cap().get()`.

- [ ] **Step 3:** Commit ALL changes (Tasks 2-5) in one commit:

```bash
git add src/cache.rs src/lib.rs src/server.rs \
        runtime/config.ts runtime/index.ts example/hello-world/index.ts \
        tests/integration.test.ts
git commit -m "$(cat <<'EOF'
feat(cache): observability endpoint + configurable capacity

Expose hits/misses/len/capacity via the native HTTP route
/_brust/cache/stats. JSON response, bypasses the worker pool
(sibling of /ping).

Configurable capacity via [cache] max_entries in brust.toml. Plumbs
through BrustConfig.cacheMaxEntries → brust.configureCache(opts) →
napi configure_cache → LruCache::resize. Default stays 1000.

LruCache.hits/misses lose their #[allow(dead_code)] attributes — both
counters are now read by stats(). Adds CacheStats (serde Serialize)
and a resize wrapper.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Architecture doc update

**Files:**
- Modify: `architecture.md`

- [ ] **Step 1:** Locate SCache. Append after the existing "Not yet implemented" bullets a "Now shipped" note that replaces the relevant bullets:

Replace:

```markdown
**Not yet implemented:**

- Control-socket invalidation (`brust-cli invalidate /path`) — lands with the CLI plan.
- `brust.toml [cache]` section for capacity/default TTL — lands with that plan.
- Cache stats endpoint (`hits`/`misses` are tracked but not surfaced).
```

With:

```markdown
**Observability:** `GET /_brust/cache/stats` returns `{hits, misses, len, capacity}` as JSON (native route, bypasses worker pool).

**Capacity:** configurable via `[cache] max_entries = N` in `brust.toml` (default 1000). Plumbed through `BrustConfig.cacheMaxEntries` → `brust.configureCache({ maxEntries })`.

**Not yet implemented:**

- Control-socket invalidation (`brust-cli invalidate /path`) — lands with the CLI plan.
- Default TTL fallback in `[cache]` — for routes that opt in without specifying `ttl_seconds`. Probably not needed; revisit if asked.
```

- [ ] **Step 2:** Locate SConfiguration. Update the schema example:

```toml
[server]
port = 3000

[workers]
count = 18

[cache]
max_entries = 5000   # default 1000
```

- [ ] **Step 3:** Locate SStatus SBuilt. Append:

```markdown
- Cache observability: `GET /_brust/cache/stats` + configurable capacity via `[cache] max_entries`
```

In SDesigned-not-built, refine the cache bullet:

```markdown
- Cache invalidation (control-socket / `brust-cli invalidate`) + default TTL fallback in `[cache]`
```

- [ ] **Step 4:** Commit:

```bash
git add architecture.md
git commit -m "$(cat <<'EOF'
docs(architecture): cache stats endpoint + [cache] config shipped

SCache: replace "stats not surfaced" + "[cache] not in TOML" with
the shipped behavior. /_brust/cache/stats + [cache] max_entries.

SConfiguration: extend schema example with [cache].

SStatus: Built gains cache observability + capacity config; the
remaining cache gaps (control-socket invalidate + default TTL) stay
in Designed-not-built.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review checklist

- [ ] `cargo build` clean. 1 warning (pre-existing `io::other::TcpStream::shutdown` only).
- [ ] `bun run test` reports 8 pass / 0 fail.
- [ ] `git log --oneline -2` shows: docs commit + feat commit.
- [ ] `git diff HEAD~2 -- runtime/routes.ts src/routes.rs src/pool.rs src/http.rs` is empty.
- [ ] `bun run dev` + `curl http://127.0.0.1:3000/_brust/cache/stats` returns JSON with `capacity: 1000` initially.
- [ ] Write a `brust.toml` with `[cache] max_entries = 50`, restart, hit `/_brust/cache/stats`, see `capacity: 50`.

## Risks / caveats

1. **Configuring cache after `serve` is technically allowed but `lru::LruCache::resize` evicts excess entries** — could cause cache thrashing if max_entries is reduced sharply on a hot cache. Documented in the JSDoc on `configureCache`. Realistic usage is "set once at boot from TOML" so the in-flight shrink case is not a real concern.
2. **`/_brust/cache/stats` is publicly readable** — anyone can see hit/miss counts. For dev/local use this is fine; production may want to restrict the `/_brust/*` prefix via a reverse proxy or future framework-level ACL. Out of scope.
3. **Stats are process-global, not per-route.** Per-route stats would need keying every counter on route_id and would balloon memory. Defer until asked.
4. **`hits`/`misses` are `Relaxed` ordering** — no synchronisation across CPUs. On the read side, the stats endpoint may see counter values that are slightly stale (microseconds). Acceptable for an observability endpoint.

## Out of scope

- Control-socket cache invalidation.
- Default TTL in `[cache]`.
- Per-route stats.
- Stats reset endpoint (e.g. `POST /_brust/cache/stats/reset`).
- Histogram of hit latencies.
- Cache size in bytes (not just entry count).
- Prometheus-format `/metrics` endpoint.
