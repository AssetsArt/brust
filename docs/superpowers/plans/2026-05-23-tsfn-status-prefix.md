# Richer tsfn return: status prefix in SAB

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Worker writes `[status_u16_BE][body...]` into the SAB and returns total bytes written. Rust reads the 2-byte prefix as the HTTP status and the rest as the body. This closes the "Mechanism gap" in `architecture.md` SMiddleware for the status side — `errorBoundary` recoveries now return `500` instead of `200`. Header mutation and TS-side middleware composition are deferred to a follow-up.

**Architecture:** SAB byte layout changes from `[html bytes]` to `[status: u16 BE][body bytes]`. Worker still returns `u32` (total bytes written; same napi type signature). `handle_conn` reads the first 2 bytes from the SAB slice to parse status, then builds the response with `build_response(status, ...)`. `makeRenderer` always emits status 200 on the happy path and **500** on the errorBoundary branch. The example app's `worker_id=` post-processing wrapper skips the 2-byte prefix when reading and preserves it when re-writing.

**Tech Stack:** Rust 2024, TypeScript 5, no new dependencies. Wire format: 2 big-endian bytes of status code preceding the body.

**Spec source:** `architecture.md` SMiddleware "Mechanism gap":
> the current tsfn contract returns only `u32` (body length); there is no channel for response headers or status. For middleware to actually mutate headers/status, the contract must evolve to either a richer return value (e.g. a struct `{ status, headers, body_len }` encoded into a fixed prefix of the SAB) or a separate tsfn handle dedicated to response metadata.

This plan ships the **smallest** surgical step: status only, encoded as a fixed 2-byte prefix. Headers + middleware composition land separately.

---

## Why status-only first

- **One concrete win:** `errorBoundary` returns HTTP 500. The Plan E test already documents this gap (`expect(resp.status).toBe(200)` with a `// Middleware plan owns 500` comment).
- **Smallest blast radius:** only `handle_conn`, `makeRenderer`, and the example's worker_id wrapper change. No new napi types, no JSON metadata layer.
- **Forward-compatible:** the prefix can grow (e.g. become `[meta_len: u16][meta bytes][body]`) without breaking the "first 2 bytes are status" invariant. Header mutation follow-up extends the prefix; the body-after-prefix shape stays.

### Files this plan touches

| File | Change |
|---|---|
| `src/server.rs` | Read first 2 bytes of SAB slice as status (u16 BE). Body = remaining bytes. Pass status to `build_response`. `n < 2` becomes a render-oversized/empty error. |
| `runtime/routes.ts` | `makeRenderer` writes `[status_u16_BE][html]` into the view. Happy path = 200, errorBoundary path = 500. Returns total bytes written (body_len + 2). |
| `example/hello-world/index.ts` | Worker_id post-processing wrapper now reads `view.subarray(2, written)` as body, mutates body, re-writes preserving the 2-byte prefix. |
| `tests/integration.test.ts` | Flip the errorBoundary test's status assertion from 200 → 500. Update the inline comment. |
| `architecture.md` SMiddleware | Note the wire format change. List status mutation as shipped; header mutation + middleware composition stay in "designed not built". |

`src/cache.rs`: **no change**. The cache stores full HTTP response bytes (status line + headers + body) built via `build_response` AFTER status is known — so cached responses naturally carry whatever status was set at render time.

`src/lib.rs`, `src/pool.rs`, `src/routes.rs`, `src/cache.rs`, `runtime/index.ts`, `runtime/config.ts`, `Cargo.toml`: untouched.

---

### Task 1: Baseline verification

**Files:** none

- [ ] **Step 1:** `cd /Users/detoro/code/brust && cargo build && bun run test`
  Expected: 1 warning (pre-existing `TcpStream::shutdown`), `7 pass, 0 fail`.
- [ ] **Step 2:** Skip commit.

---

### Task 2: Update the failing test to assert the new contract

**Files:**
- Modify: `tests/integration.test.ts`

Flip the errorBoundary test's status expectation **before** changing implementation. This proves the test catches the new behavior (RED) before the impl flips it green.

- [ ] **Step 1:** Locate the `errorBoundary renders when a route component throws` test. Currently:

```typescript
    const resp = await fetch(`http://127.0.0.1:${port}/crash`)
    // Status is 200 even on errorBoundary recovery — see plan note.
    // Middleware plan introduces a richer tsfn return so 500 becomes possible.
    expect(resp.status).toBe(200)
    const body = await resp.text()
    expect(body).toContain('CrashBoundary')
    expect(body).toContain('intentional crash for test')
```

Replace with:

```typescript
    const resp = await fetch(`http://127.0.0.1:${port}/crash`)
    // errorBoundary now returns 500 — the worker encodes the status in the
    // 2-byte SAB prefix that Rust reads before building the response.
    expect(resp.status).toBe(500)
    const body = await resp.text()
    expect(body).toContain('CrashBoundary')
    expect(body).toContain('intentional crash for test')
```

- [ ] **Step 2:** Run `bun run test`.
Expected: this test now fails — `expect(resp.status).toBe(500)` reports `received: 200` because makeRenderer + handle_conn still use the old contract. The other 6 tests pass.

If `7 pass` appears, something is wrong — the contract is supposedly broken until Task 3, so this assertion must fail.

- [ ] **Step 3:** Commit RED:

```bash
git add tests/integration.test.ts
git commit -m "$(cat <<'EOF'
test(http): errorBoundary should return HTTP 500 not 200

Flips the assertion in `errorBoundary renders when a route component
throws` from 200 → 500. The new contract is that the worker encodes
status in a 2-byte big-endian prefix in the SAB and Rust uses that
when building the response. RED until the prefix wire format lands.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Implement the wire change end-to-end

Single commit covering the Rust read, the TS write, and the example app's wrapper update. The build is only green after all three land.

**Files:**
- Modify: `src/server.rs`
- Modify: `runtime/routes.ts`
- Modify: `example/hello-world/index.ts`

- [ ] **Step 1: `src/server.rs` — read status from SAB prefix**

Locate the render-success branch in `handle_conn` (currently the block under `Ok(promise) => match promise.await { Ok(n) => { ... } }`). The existing block extracts body from the SAB and builds the response:

```rust
                Ok(n) => {
                    let n = n as usize;
                    if n == 0 || n > entry.buf_len {
                        error!(worker_id = entry.id, written = n, capacity = entry.buf_len, "render oversized or empty");
                        let _ = s.write_all(http::build_response(500, "text/plain", b"render oversized".to_vec())).await;
                        return;
                    }
                    // SAFETY: see pool.rs BufPtr safety argument.
                    let body: Vec<u8> = unsafe {
                        std::slice::from_raw_parts(entry.buf_ptr.0, n).to_vec()
                    };
                    let bytes = http::build_response(200, "text/html; charset=utf-8", body);
                    if let (Some(key), Some(cfg)) = (cache_key, cache_config.as_ref()) {
                        cache.insert(key, bytes.clone(), Duration::from_secs(cfg.ttl_seconds));
                    }
                    if s.write_all(bytes).await.is_err() {
                        return;
                    }
                }
```

Replace with:

```rust
                Ok(n) => {
                    let n = n as usize;
                    // n must include the 2-byte status prefix + at least 1 body byte.
                    if n < 3 || n > entry.buf_len {
                        error!(worker_id = entry.id, written = n, capacity = entry.buf_len, "render oversized or empty");
                        let _ = s.write_all(http::build_response(500, "text/plain", b"render oversized".to_vec())).await;
                        return;
                    }
                    // SAFETY: see pool.rs BufPtr safety argument.
                    let raw: Vec<u8> = unsafe {
                        std::slice::from_raw_parts(entry.buf_ptr.0, n).to_vec()
                    };
                    // First 2 bytes (big-endian) carry the HTTP status code.
                    let status = u16::from_be_bytes([raw[0], raw[1]]);
                    let body = raw[2..].to_vec();
                    let bytes = http::build_response(status, "text/html; charset=utf-8", body);
                    if let (Some(key), Some(cfg)) = (cache_key, cache_config.as_ref()) {
                        cache.insert(key, bytes.clone(), Duration::from_secs(cfg.ttl_seconds));
                    }
                    if s.write_all(bytes).await.is_err() {
                        return;
                    }
                }
```

Notes:
- The lower bound goes from `n == 0` to `n < 3` because a valid response needs at minimum 2 status bytes + 1 body byte.
- `u16::from_be_bytes([raw[0], raw[1]])` parses the status as big-endian unsigned 16-bit.
- `raw[2..].to_vec()` is one allocation; the original `from_raw_parts(...).to_vec()` was also one allocation, so no net change.
- `build_response(status, ...)` already handles all common statuses (200, 400, 404, 405, 414, 500, 502, 503). For 500, the status text "Internal Server Error" applies; the existing match in `http::build_response` covers it. Any unrecognized status code falls through to "Unknown" text — acceptable for an MVP.

- [ ] **Step 2: `runtime/routes.ts` — write status into SAB prefix**

Locate `makeRenderer` (currently in `runtime/routes.ts`). Replace the entire function with:

```typescript
export function makeRenderer(
  routes: Route[],
  view: Uint8Array,
): (envelopeJson: string) => Promise<number> {
  const encoder = new TextEncoder()
  const byId = new Map<number, Route>()
  routes.forEach((r, i) => byId.set(i, r))

  return async (envelopeJson: string): Promise<number> => {
    const call = JSON.parse(envelopeJson) as RouteCall
    const route = byId.get(call.route_id)
    if (!route) {
      console.error(`[brust] unknown route_id=${call.route_id} for path=${call.path}`)
      return 0
    }

    let html: string
    let status = 200
    try {
      html = renderToString(
        createElement(route.Component, { params: call.params, path: call.path }),
      )
    } catch (renderErr) {
      if (!route.errorBoundary) throw renderErr
      const boundary: ReactNode = createElement(route.errorBoundary, {
        error: renderErr instanceof Error ? renderErr : new Error(String(renderErr)),
      })
      html = renderToString(boundary as any)
      status = 500
    }

    // Wire format: [status_u16_BE][body bytes].
    view[0] = (status >> 8) & 0xff
    view[1] = status & 0xff
    const bodyView = view.subarray(2)
    const { written } = encoder.encodeInto(html, bodyView)
    if (written === undefined) return 0
    return written + 2
  }
}
```

Notes:
- `status >> 8` and `status & 0xff` are the standard big-endian 2-byte encoding.
- `encoder.encodeInto(html, bodyView)` writes into the SAB starting at offset 2.
- Return `written + 2` — total bytes occupied in the SAB.
- `written === undefined` (encoder failed to fit any byte) returns `0`, which Rust treats as oversized.

- [ ] **Step 3: `example/hello-world/index.ts` — update the worker_id wrapper**

The example's existing wrapper read the SAB as a single body. Now there's a 2-byte status prefix to preserve. Locate the worker branch:

```typescript
} else {
  const sab = new SharedArrayBuffer(256 * 1024)
  const view = new Uint8Array(sab)

  let wid = ''
  const renderer = makeRenderer(routes, view)

  // Wrap renderer once to inject workerId into HelloWorld's `worker_id=` line
  // for the existing integration test. This is example-local; goes away when
  // loader/context lands.
  const dec = new TextDecoder()
  const id = brust.registerRenderer(view, async (envelopeJson) => {
    const written = await renderer(envelopeJson)
    if (wid === '') return written
    const html = dec.decode(view.subarray(0, written))
    const patched = html.replace('worker_id=', `worker_id=${wid}`)
    if (patched === html) return written
    const enc2 = new TextEncoder()
    const { written: w2 } = enc2.encodeInto(patched, view)
    return w2 ?? 0
  })
  wid = String(id)
}
```

Replace the inner async callback with one that respects the 2-byte prefix:

```typescript
  const id = brust.registerRenderer(view, async (envelopeJson) => {
    const written = await renderer(envelopeJson)
    if (wid === '' || written < 2) return written
    // The first 2 bytes are the status prefix; the body starts at offset 2.
    const html = dec.decode(view.subarray(2, written))
    const patched = html.replace('worker_id=', `worker_id=${wid}`)
    if (patched === html) return written
    // Re-encode the patched body back into the SAB, preserving the prefix.
    const enc2 = new TextEncoder()
    const bodyView = view.subarray(2)
    const { written: w2 } = enc2.encodeInto(patched, bodyView)
    if (w2 === undefined) return 0
    return w2 + 2
  })
```

The two changes:
1. Reading: `view.subarray(2, written)` (was `view.subarray(0, written)`).
2. Writing: `view.subarray(2)` as the destination (was `view`), and return `w2 + 2`.

The 2-byte prefix written by `makeRenderer` stays intact — we never touch `view[0]` or `view[1]` in the wrapper.

- [ ] **Step 4: Rebuild + test**

```bash
cd /Users/detoro/code/brust
cargo build       # expect: 1 pre-existing warning
cd runtime && bun run build:debug && cd -
bun run test      # expect: 7 pass, 0 fail
```

If `routes /blog/:slug renders BlogPost with the slug param` now fails with status 0 or weird mismatches → the prefix is being read wrong. Add a `console.log({ written, firstByte: view[0], secondByte: view[1] })` in the renderer to inspect.

If `cache-test route returns same body on second hit` fails → the cache stored bytes from BEFORE this change (it shouldn't, since each test run starts a fresh process), or the prefix is somehow being included in the cached body. Note: the cache stores the FULL HTTP response bytes (after `build_response`), so the prefix has already been consumed at cache-write time — no issue.

If `errorBoundary renders when a route component throws` still reports status 200 → the makeRenderer try/catch isn't setting `status = 500`, or the prefix bytes are being written but Rust isn't reading them.

- [ ] **Step 5: Commit**

```bash
git add src/server.rs runtime/routes.ts example/hello-world/index.ts
git commit -m "$(cat <<'EOF'
feat(http): worker encodes status in 2-byte SAB prefix

Wire format change: the worker now writes [status_u16_BE][body] into
the SAB and returns body_len + 2 as the total bytes written. Rust
parses the first 2 bytes as the HTTP status code (big-endian unsigned
16-bit) and uses that when calling build_response instead of the
hard-coded 200.

makeRenderer (runtime/routes.ts):
- Happy path emits status 200.
- errorBoundary recovery emits status 500.

handle_conn (src/server.rs):
- Lower bound for "valid render" is now n >= 3 (2 prefix bytes + at
  least 1 body byte).
- Reads status from raw[0..2] via u16::from_be_bytes.
- Body slice is raw[2..].

example/hello-world's worker_id post-processing wrapper updated to
read from view.subarray(2, written) and write into view.subarray(2),
preserving the prefix.

The cache (src/cache.rs) is unchanged — it stores the full HTTP
response bytes built via build_response, which has the status baked
in. Cached responses naturally carry whatever status the render
emitted.

Header mutation and TS-side middleware composition are deferred to a
follow-up plan. This commit ships the smallest surgical step that
closes the "errorBoundary returns 200" gap from Plan E.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Update architecture.md SMiddleware and SStatus

**Files:**
- Modify: `architecture.md`

- [ ] **Step 1:** Locate the SMiddleware "Mechanism gap" paragraph (around lines 605-619 — search for "Mechanism gap"). Update to reflect that status is now wired:

```markdown
**Mechanism gap (partially closed):** the tsfn signature still returns
`u32` (total bytes), but the SAB layout is now `[status: u16 BE][body]`
— Rust reads the prefix and uses it when calling `build_response`. This
unlocks status-side middleware (errorBoundary returns 500 today). Response
header mutation still has no channel — the next follow-up extends the
prefix to `[meta_len: u16][meta JSON][body]` carrying a `{status, headers}`
struct.
```

- [ ] **Step 2:** SStatus. Move the "richer tsfn return (status)" into **Built**:

In the **Built** list, append:

```markdown
- Richer tsfn return: status prefix in SAB (`errorBoundary` recoveries now return HTTP 500)
```

In **Designed, not built**, add (or refine if already present):

```markdown
- Middleware: response header mutation channel + TS-side composition (per-route + global)
```

- [ ] **Step 3:** Commit:

```bash
git add architecture.md
git commit -m "$(cat <<'EOF'
docs(architecture): tsfn status prefix is shipped; header mutation deferred

SMiddleware "Mechanism gap" paragraph: note the SAB layout
[status_u16_BE][body] closes the status-side half of the gap.
errorBoundary recoveries now return HTTP 500 (Plan E's TODO).

SStatus: Built gains "Richer tsfn return: status prefix"; the
remaining middleware work (header mutation + composition) stays
in Designed-not-built under a clarified bullet.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review checklist (run before declaring done)

- [ ] `cargo build` clean. 1 warning (pre-existing `io::other::TcpStream::shutdown`). No new warnings.
- [ ] `bun run test` reports `7 pass, 0 fail`. The `errorBoundary renders when a route component throws` test now passes with status 500.
- [ ] `git log --oneline -3` shows: docs commit, feat commit, test commit (RED).
- [ ] `git diff HEAD~3 -- src/cache.rs` is empty (cache unchanged).
- [ ] `git diff HEAD~3 -- runtime/index.ts` is empty (registerRoutes contract unchanged).
- [ ] `bun run dev` + `curl -i http://127.0.0.1:3000/crash` returns `HTTP/1.1 500 Internal Server Error` with body containing `CrashBoundary`.
- [ ] `bun run dev` + `curl -i http://127.0.0.1:3000/blog/foo` returns `HTTP/1.1 200 OK` with body containing `BlogPost`.

## Risks / caveats

1. **The SAB[0..2] is now reserved for status.** Any tooling that reads/writes the SAB directly (e.g. future Streaming HTML plan) must respect this offset. The Streaming plan's "Function<u32, Promise<()>>" variant will need its own contract decision: either inherit the prefix or use a different SAB region.
2. **Big-endian was chosen for human-readable hex dumps** (`00 c8` = 200, `01 f4` = 500). The TS side encodes via bit-shift, which is platform-independent — no DataView needed.
3. **Cache stores post-`build_response` bytes**, so the cache key is per-(route, vary, ...) and the cached entry implicitly remembers the status. A cached errorBoundary 500 will be served as 500. Not currently expected (we cache only on render success which is always 200), but worth knowing.
4. **`build_response` calls for unknown status codes write "Unknown" as status text.** This shows up if a future renderer emits e.g. 418 without `build_response` knowing the name. Extend the `match status` block when needed.

## Out of scope (for the next plan)

- **Response header mutation.** Workers can't set custom headers yet. Plan: extend the prefix to `[meta_len: u16][meta JSON][body]` where meta is `{status, headers: [[name, value], ...]}`. Backward-compatible with this plan's `[status u16][body]` layout if `meta_len` is 0 — but for clarity the follow-up will use a distinct layout flag in the first byte.
- **TS-side middleware composition.** `middleware.ts` with the `(req, next) => res` chain. Lands once header mutation is wired.
- **Per-route middleware.** Same plan as above.
- **Streaming HTML (`renderToPipeableStream`).** Independent plan; the prefix scheme there is a per-chunk signal, not a single response.
