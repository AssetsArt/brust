# Cache Invalidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Operators can purge cached responses by path or clear the entire cache via a native HTTP endpoint. Closes the cache surface — combined with already-shipped `cache: {ttl_seconds, vary}` opt-in, `/_brust/cache/stats` observability, and `[cache] max_entries` capacity.

**Architecture:**
- New native endpoint `POST /_brust/cache/invalidate?path=/foo` purges all entries whose `(method, path)` matches `/foo` regardless of query string or vary header values. Returns JSON `{removed: N}`.
- `POST /_brust/cache/invalidate?all=1` clears the whole cache. Returns JSON `{removed: N}`.
- Server.rs `method != "GET"` guard relaxes to allow POST when path == `/_brust/cache/invalidate`. All other non-GET paths still 405.
- `LruCache` gains `invalidate_path(method, path) -> usize` and `clear() -> usize`. Implementation iterates the LRU snapshot, collects matching keys, then pops them — `lru` crate has no remove-by-predicate.
- Hits/misses counters survive invalidation (operator-visible state); only `len` decreases.

**Tech Stack:** Rust (`lru` 0.12, `parking_lot`, `serde_json`), no new deps.

**Out of scope (deferred):**
- `brust-cli invalidate /path` — CLI tool needs its own plan (project tooling broader).
- Authentication on the endpoint — apps using Brust in untrusted environments should reverse-proxy and gate the `/_brust/*` prefix externally; Brust's middleware (just shipped) can also intercept.
- TTL extension / refresh-on-write semantics — current behavior (lazy TTL eviction) stays.
- Per-route purge by route_id rather than path string.
- Default TTL fallback in `[cache]` TOML — semantics unclear (apply to all routes? only opt-in routes without explicit ttl?); skip until a real need surfaces.

---

## File Structure

**No new files.** Surgical change in three existing files.

**Rust:**
- `src/cache.rs` — add `invalidate_path` + `clear` methods on `LruCache`; unit tests for both.
- `src/server.rs` — allow POST on the invalidate endpoint; implement the endpoint handler that parses `?path=` / `?all=1` from the request line.

**Tests:**
- `tests/integration.test.ts` — 2 new integration tests (invalidate by path, clear all).

**Docs:**
- `architecture.md` — Cache section gets an invalidation paragraph; Designed-not-built loses the cache-invalidation bullet.

---

## Task 1: Add `invalidate_path` + `clear` to `LruCache`

**Files:**
- Modify: `src/cache.rs` (append methods + tests)

- [ ] **Step 1: Add `invalidate_path` and `clear` methods**

Append these methods to the `impl LruCache` block in `src/cache.rs` (after `resize` at line 106):

```rust
    /// Remove every entry whose key has the given method + path (regardless
    /// of query string or vary values). Returns the number of entries
    /// removed. Hits/misses counters are NOT reset.
    pub fn invalidate_path(&self, method: &str, path: &str) -> usize {
        let mut guard = self.inner.lock();
        // lru 0.12 has no remove-by-predicate. Snapshot the matching keys,
        // then pop each. Allocation cost is proportional to matches, not
        // total cache size.
        let to_remove: Vec<CacheKey> = guard
            .iter()
            .filter(|(k, _)| k.method == method && k.path == path)
            .map(|(k, _)| k.clone())
            .collect();
        for k in &to_remove {
            guard.pop(k);
        }
        to_remove.len()
    }

    /// Remove every entry. Hits/misses counters are NOT reset (they
    /// represent lifetime totals; operators wanting a fresh window can
    /// scrape `/stats` and compute deltas).
    pub fn clear(&self) -> usize {
        let mut guard = self.inner.lock();
        let removed = guard.len();
        guard.clear();
        removed
    }
```

- [ ] **Step 2: Add unit tests at the bottom of `src/cache.rs`**

Append after the `impl Default` block:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn key(method: &str, path: &str, query: &str) -> CacheKey {
        CacheKey {
            method: method.to_string(),
            path: path.to_string(),
            sorted_query: query.to_string(),
            vary_values: Vec::new(),
        }
    }

    #[test]
    fn invalidate_path_removes_only_matching_entries() {
        let c = LruCache::new();
        c.insert(key("GET", "/a", ""), b"a".to_vec(), Duration::from_secs(60));
        c.insert(key("GET", "/a", "x=1"), b"a-x".to_vec(), Duration::from_secs(60));
        c.insert(key("GET", "/b", ""), b"b".to_vec(), Duration::from_secs(60));

        let removed = c.invalidate_path("GET", "/a");
        assert_eq!(removed, 2);
        assert!(c.get(&key("GET", "/a", "")).is_none());
        assert!(c.get(&key("GET", "/a", "x=1")).is_none());
        assert_eq!(c.get(&key("GET", "/b", "")), Some(b"b".to_vec()));
    }

    #[test]
    fn invalidate_path_no_match_returns_zero() {
        let c = LruCache::new();
        c.insert(key("GET", "/a", ""), b"a".to_vec(), Duration::from_secs(60));
        assert_eq!(c.invalidate_path("GET", "/missing"), 0);
        assert_eq!(c.invalidate_path("POST", "/a"), 0);
        assert_eq!(c.stats().len, 1);
    }

    #[test]
    fn clear_removes_all_entries_and_returns_count() {
        let c = LruCache::new();
        c.insert(key("GET", "/a", ""), b"a".to_vec(), Duration::from_secs(60));
        c.insert(key("GET", "/b", ""), b"b".to_vec(), Duration::from_secs(60));
        c.insert(key("GET", "/c", ""), b"c".to_vec(), Duration::from_secs(60));
        let removed = c.clear();
        assert_eq!(removed, 3);
        assert_eq!(c.stats().len, 0);
    }

    #[test]
    fn invalidate_and_clear_preserve_hits_and_misses() {
        let c = LruCache::new();
        c.insert(key("GET", "/a", ""), b"a".to_vec(), Duration::from_secs(60));
        let _ = c.get(&key("GET", "/a", "")); // hit
        let _ = c.get(&key("GET", "/missing", "")); // miss
        assert_eq!(c.stats().hits, 1);
        assert_eq!(c.stats().misses, 1);

        c.invalidate_path("GET", "/a");
        assert_eq!(c.stats().hits, 1);
        assert_eq!(c.stats().misses, 1);

        c.clear();
        assert_eq!(c.stats().hits, 1);
        assert_eq!(c.stats().misses, 1);
    }
}
```

- [ ] **Step 3: Run the unit tests**

Run: `cd /Users/detoro/code/brust && cargo test --lib cache::`
Expected: 4 new tests pass (plus any pre-existing tests in this module — none, so just 4).

- [ ] **Step 4: Commit**

```bash
cd /Users/detoro/code/brust
git add src/cache.rs
git commit -m "$(cat <<'EOF'
feat(cache): add invalidate_path + clear to LruCache

invalidate_path(method, path) -> usize removes all entries matching the
given method+path regardless of query string or vary values. clear() ->
usize wipes the cache. Hits/misses counters survive both (lifetime totals).

4 unit tests cover: targeted invalidation, no-match returns zero, clear
returns count, counters preserved across both operations.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Expose the invalidation endpoint in `handle_conn`

**Files:**
- Modify: `src/server.rs` (relax method gate; add endpoint handler before route lookup)

- [ ] **Step 1: Relax the method gate to allow POST on the invalidate endpoint**

In `src/server.rs`, find the existing block (around lines 123-126):

```rust
        if method != "GET" {
            let _ = s.write_all(http::error_405()).await;
            return;
        }
```

Replace it with:

```rust
        // POST is only legal for /_brust/cache/invalidate; everything else
        // requires GET. Move the gate further down so the path-aware POST
        // dispatch can run first.
        if method != "GET" && !(method == "POST" && path == "/_brust/cache/invalidate") {
            let _ = s.write_all(http::error_405()).await;
            return;
        }
```

- [ ] **Step 2: Add the invalidation endpoint handler**

Find the `/_brust/cache/stats` block (around lines 137-146):

```rust
        // Native-only route: cache observability. JSON of hits/misses/len/capacity.
        if path == "/_brust/cache/stats" {
            let stats = cache.stats();
            let json = serde_json::to_string(&stats).unwrap_or_else(|_| String::from("{}"));
            let bytes = http::build_response(200, "application/json", &[], json.into_bytes());
            if s.write_all(bytes).await.is_err() {
                return;
            }
            continue;
        }
```

Immediately AFTER this block (before the `routes.match_path(...)` call), add:

```rust
        // Native-only route: cache invalidation.
        //   POST /_brust/cache/invalidate?path=/foo  → purge by (GET, /foo)
        //   POST /_brust/cache/invalidate?all=1      → clear all entries
        // Response: 200 application/json {"removed": N}. Path mismatch on
        // ?path= is not an error; returns {"removed":0}.
        if path.starts_with("/_brust/cache/invalidate") {
            let query = path.split_once('?').map(|(_, q)| q).unwrap_or("");
            let mut target_path: Option<String> = None;
            let mut clear_all = false;
            for pair in query.split('&') {
                if pair.is_empty() {
                    continue;
                }
                match pair.split_once('=') {
                    Some(("path", v)) => target_path = Some(percent_decode(v)),
                    Some(("all", v)) if v == "1" || v == "true" => clear_all = true,
                    _ => {}
                }
            }
            let removed = if clear_all {
                cache.clear()
            } else if let Some(p) = target_path {
                // Invalidate the GET variant; this server doesn't cache POST.
                cache.invalidate_path("GET", &p)
            } else {
                let bytes = http::build_response(
                    400,
                    "application/json",
                    &[],
                    br#"{"error":"missing path or all parameter"}"#.to_vec(),
                );
                if s.write_all(bytes).await.is_err() {
                    return;
                }
                continue;
            };
            let body = format!(r#"{{"removed":{removed}}}"#);
            let bytes = http::build_response(200, "application/json", &[], body.into_bytes());
            if s.write_all(bytes).await.is_err() {
                return;
            }
            continue;
        }
```

- [ ] **Step 3: Add the `percent_decode` helper**

The endpoint needs to decode `%2F` etc. in query values. Add this helper near the existing helpers in `src/server.rs` (e.g., after `sort_query`):

```rust
/// Minimal percent-decode for query-string values in native endpoints.
/// Handles `%xx` and `+` → space; unrecognised escapes pass through.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hi = (bytes[i + 1] as char).to_digit(16);
                let lo = (bytes[i + 2] as char).to_digit(16);
                match (hi, lo) {
                    (Some(h), Some(l)) => {
                        out.push(((h << 4) | l) as u8);
                        i += 3;
                    }
                    _ => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8(out).unwrap_or_default()
}
```

(This is a duplicate of `url_decode` in `src/routes.rs`. Resist refactoring into a shared module — the routes-side decoder is a closure with a particular call shape, and the duplication is small. If a third caller appears later, extract to `src/util.rs`.)

- [ ] **Step 4: Build to confirm**

Run: `cd /Users/detoro/code/brust && cargo build`
Expected: clean build (1 pre-existing `io::other` warning OK).

- [ ] **Step 5: Commit**

```bash
git add src/server.rs
git commit -m "$(cat <<'EOF'
feat(server): native cache invalidation endpoint

POST /_brust/cache/invalidate?path=/foo purges all cache entries for
(GET, /foo) regardless of query string or vary values.
POST /_brust/cache/invalidate?all=1 clears the entire cache.
Response: {"removed": N}.

Method gate relaxed to allow POST only on this single path; all other
non-GET methods still return 405.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Integration tests

**Files:**
- Modify: `tests/integration.test.ts` (append 2 new tests before `readPortLine`)

- [ ] **Step 1: Append 2 new tests**

Add at the end of `tests/integration.test.ts`, immediately before the `async function readPortLine(...)` line:

```ts
test('invalidate by path drops a cached entry', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: {
      ...process.env,
      BRUST_PORT: '38171',
      BRUST_WORKERS: '1',
      RUST_LOG: 'brust=info',
    },
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    // Warm the cache for /cache-test (CacheTest's body contains a counter
    // that changes on re-render; cache hit returns identical bytes).
    const first = await fetch(`http://127.0.0.1:${port}/cache-test`)
    const firstBody = await first.text()
    expect(first.status).toBe(200)

    // Hit again → cache hit → identical body.
    const cached = await fetch(`http://127.0.0.1:${port}/cache-test`)
    expect(await cached.text()).toBe(firstBody)

    // Invalidate just that path.
    const inv = await fetch(`http://127.0.0.1:${port}/_brust/cache/invalidate?path=/cache-test`, {
      method: 'POST',
    })
    expect(inv.status).toBe(200)
    expect(inv.headers.get('content-type')).toBe('application/json')
    const body = await inv.json() as { removed: number }
    expect(body.removed).toBeGreaterThanOrEqual(1)

    // Next request re-renders (counter advances) → body must differ from firstBody.
    const reRender = await fetch(`http://127.0.0.1:${port}/cache-test`)
    expect(reRender.status).toBe(200)
    expect(await reRender.text()).not.toBe(firstBody)
  } finally {
    proc.kill('SIGINT')
    const exit = await proc.exited
    expect(exit).toBe(0)
  }
}, 15_000)

test('invalidate all clears every entry + reports correct removed count', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: {
      ...process.env,
      BRUST_PORT: '38172',
      BRUST_WORKERS: '1',
      RUST_LOG: 'brust=info',
    },
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    // Warm /cache-test (only cached route in the example).
    await fetch(`http://127.0.0.1:${port}/cache-test`)
    const beforeStats = await (await fetch(`http://127.0.0.1:${port}/_brust/cache/stats`)).json() as {
      hits: number, misses: number, len: number, capacity: number,
    }
    expect(beforeStats.len).toBeGreaterThanOrEqual(1)

    const inv = await fetch(`http://127.0.0.1:${port}/_brust/cache/invalidate?all=1`, {
      method: 'POST',
    })
    expect(inv.status).toBe(200)
    const body = await inv.json() as { removed: number }
    expect(body.removed).toBe(beforeStats.len)

    const afterStats = await (await fetch(`http://127.0.0.1:${port}/_brust/cache/stats`)).json() as {
      hits: number, misses: number, len: number,
    }
    expect(afterStats.len).toBe(0)
    // Counters are preserved (hits/misses survive clear).
    expect(afterStats.hits).toBe(beforeStats.hits)
    expect(afterStats.misses).toBe(beforeStats.misses)
  } finally {
    proc.kill('SIGINT')
    const exit = await proc.exited
    expect(exit).toBe(0)
  }
}, 15_000)

test('invalidate endpoint rejects GET and unsupported queries', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: {
      ...process.env,
      BRUST_PORT: '38173',
      BRUST_WORKERS: '1',
      RUST_LOG: 'brust=info',
    },
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    // GET on the invalidate endpoint must not work (POST-only).
    const wrongMethod = await fetch(`http://127.0.0.1:${port}/_brust/cache/invalidate?path=/x`)
    expect(wrongMethod.status).toBe(405)

    // POST without path or all=1 returns 400.
    const missingParams = await fetch(`http://127.0.0.1:${port}/_brust/cache/invalidate`, {
      method: 'POST',
    })
    expect(missingParams.status).toBe(400)
    const body = await missingParams.json() as { error: string }
    expect(body.error).toContain('missing')
  } finally {
    proc.kill('SIGINT')
    const exit = await proc.exited
    expect(exit).toBe(0)
  }
}, 15_000)
```

- [ ] **Step 2: Rebuild + run the full suite**

Run:
```bash
cd /Users/detoro/code/brust/runtime && bun run build:debug && cd -
cd /Users/detoro/code/brust && bun run test
```

Expected: **15 tests pass** (12 from the prior plan + 3 new).

- [ ] **Step 3: Commit**

```bash
git add tests/integration.test.ts
git commit -m "$(cat <<'EOF'
test(integration): cache invalidation endpoint

- POST /_brust/cache/invalidate?path=/cache-test removes the cached
  entry; next fetch re-renders and produces a different body (the
  CacheTest counter advances).
- POST /_brust/cache/invalidate?all=1 clears all entries; stats len
  drops to 0; hits/misses counters survive.
- GET on the endpoint returns 405; POST with no params returns 400.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Update `architecture.md`

**Files:**
- Modify: `architecture.md` (Cache section + Built/Designed-not-built lists)

- [ ] **Step 1: Add invalidation paragraph to the Cache section**

Find the Cache section in `architecture.md` (search for `### Cache`). After the existing observability paragraph, append:

```
**Invalidation.** Two native endpoints purge cached entries:

- `POST /_brust/cache/invalidate?path=/foo` — drops every cache entry
  whose key has `(method=GET, path=/foo)`, regardless of query string
  or vary values. Returns `{"removed": N}`.
- `POST /_brust/cache/invalidate?all=1` — clears the whole cache.
  Returns `{"removed": N}`.

`GET` and other methods return 405. Both calls preserve hits/misses
counters (they're lifetime totals). The endpoint is *unauthenticated*
by design — apps running Brust in untrusted environments should
reverse-proxy and gate the `/_brust/*` prefix externally, or wrap
their own auth middleware on the surrounding deploy.
```

- [ ] **Step 2: Promote invalidation in the Built list**

Find the Built list (around line 955-973). After the line about cache observability, add:

```
- Cache invalidation: `POST /_brust/cache/invalidate?path=/foo` (purge by path) and `?all=1` (clear all) — returns `{"removed": N}` JSON
```

- [ ] **Step 3: Remove the cache-invalidation bullet from Designed-not-built**

Find the line (around line 977-989):

```
- Cache invalidation (control-socket / `brust-cli invalidate`) + default TTL fallback in `[cache]`
```

Replace with:

```
- `brust-cli invalidate` (project tooling — separate from the native endpoint that just shipped)
- Default TTL fallback in `[cache]` (semantics deferred — no current consumer)
```

- [ ] **Step 4: Final verify run**

```bash
cd /Users/detoro/code/brust
cargo build
cargo test --lib                    # 22+ tests (existing + 4 new cache tests)
cd runtime && bun run build:debug && cd -
bun run test                        # 15 tests
```

Expected: cargo clean (1 pre-existing warning OK), 22 unit tests pass, 15 integration tests pass.

- [ ] **Step 5: Commit**

```bash
git add architecture.md
git commit -m "$(cat <<'EOF'
docs(architecture): cache invalidation endpoint shipped

POST /_brust/cache/invalidate?path=/foo (by path) and ?all=1 (clear all).
Designed-not-built loses the cache-invalidation bullet; brust-cli +
default-TTL stays as future work.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Verification checklist

```bash
cargo build                                    # clean
cargo test --lib                               # 22 pass (existing 18 + 4 cache)
cd runtime && bun run build:debug && cd -      # rebuild .node
bun run test                                   # 15 pass
```

Manual sanity:

```bash
BRUST_PORT=38500 bun run example/hello-world/index.ts &
# Warm /cache-test
curl -s http://127.0.0.1:38500/cache-test > /dev/null
curl -s http://127.0.0.1:38500/_brust/cache/stats     # {"hits":..,"misses":..,"len":>=1,...}
# Invalidate by path
curl -s -X POST 'http://127.0.0.1:38500/_brust/cache/invalidate?path=/cache-test'
# {"removed":1}
# Re-warm then clear all
curl -s http://127.0.0.1:38500/cache-test > /dev/null
curl -s -X POST 'http://127.0.0.1:38500/_brust/cache/invalidate?all=1'
# {"removed":1}
curl -s http://127.0.0.1:38500/_brust/cache/stats     # len=0, hits/misses preserved
```

---

## Risks / caveats

1. **Iterating the LRU under the lock holds the Mutex for O(N) on `invalidate_path` calls** — N = total cache entries (1000 default). On the M1 Pro with the existing benchmark, that's ~10µs single-pass. Worker threads waiting on the lock will block briefly. Acceptable for an admin-triggered operation. Document explicitly: invalidation calls should not be on the request-rate hot path; treat as ops-tooling.

2. **`invalidate_path` only invalidates the GET variant** — the server only ever caches GET (POST is only legal for the new endpoint itself). Future support for cached POST/HEAD would need the endpoint to grow a `?method=` parameter; deferred.

3. **No auth on the endpoint** — explicit design choice. Apps must reverse-proxy or use middleware to gate `/_brust/*`. Document in architecture.md.

4. **Cache key includes `sorted_query` + `vary_values`** — but invalidation by path ignores both, so e.g. `cache-test?v=1` and `cache-test?v=2` both drop on `?path=/cache-test`. This is the right semantic (operators wanting to purge a page don't track every query/vary combination).

5. **Hits/misses counters are NEVER reset** — including by `clear()`. They're lifetime totals. Operators wanting a "fresh window" should scrape `/stats` and compute deltas. If a real need surfaces for "reset counters", add a `?reset_counters=1` flag in a follow-up.

6. **Empty / malformed query strings** — `?path=` (empty value) sets `target_path = Some("")` which then invalidates `(GET, "")`. That's almost certainly not a real route, so removed = 0. Acceptable.

7. **`percent_decode` duplication with `routes::url_decode`** — both functions do the same thing. Resist refactoring until a third caller appears (rule of three).

---

*End of plan.*
