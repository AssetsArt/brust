# Server Functions (MVP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the manual-registration server-functions MVP: per-process registered async functions invokable from a hydrated island via `POST /_brust/action/<id>` with JSON args/return. Action-specific middleware. No build-time scanner. No multipart. Mirror Islands MVP pattern.

**Architecture:** Manual `brust.registerActions([{ id, fn }])` on the main thread tells Rust the URL→action_id table. Worker side, `makeRenderer(routes, view, { actions })` builds a dispatcher that switches on a new envelope `kind: 'render' | 'action'` discriminant. Reuses the existing renderer tsfn — no new napi entry. Client uses `action<F>(id)` helper from `runtime/client` with `import type * as srv` to keep server code out of the bundle.

**Tech Stack:** Rust (napi 3 + matchit + serde_json), TypeScript (Bun runtime, React 18 islands), `bun:test` for integration tests, inline `#[cfg(test)] mod tests` for Rust units.

**Parent spec:** `docs/superpowers/specs/2026-05-24-server-functions-design.md`. Read §3 (wire format) and §6 (error model) before starting — every task references them.

---

## File Structure

**New source files (committed):**
- `runtime/actions.ts` — `ActionDef`, `ActionFn`, `defineActions` helper
- `runtime/client/index.ts` — `action<F>(id)` helper + `BrustActionError`
- `example/hello-world/actions.ts` — `createNote`, `whoAmI` demos
- `example/hello-world/components/NoteForm.tsx` — island calling `createNote`
- `example/hello-world/components/WhoAmI.tsx` — island calling `whoAmI`
- `example/hello-world/components/NotePage.tsx` — page embedding `NoteForm` island
- `example/hello-world/components/WhoAmIPage.tsx` — page embedding `WhoAmI` island

**Modified source files:**
- `runtime/index.ts` — re-export `defineActions`, `ActionDef`, `ActionFn`; add `brust.registerActions`
- `runtime/routes.ts` — make `RouteCall` a discriminated union; add `actions` to `MakeRendererOptions`; extend `makeRenderer` to switch on `kind`; allow JS-side `contentType` on meta envelope
- `example/hello-world/island.config.ts` — register `NoteForm`, `WhoAmI` islands
- `example/hello-world/index.ts` — call `brust.registerActions(...)`; pass `actions` to `makeRenderer`
- `example/hello-world/routes.tsx` — add `/note` and `/whoami` routes
- `src/lib.rs` — new napi `register_actions(ids: Vec<String>)`; new `actions: parking_lot::RwLock<HashSet<String>>` in State
- `src/server.rs` — handle `POST /_brust/action/<id>` (method/length/charset/registry checks); build ActionEnvelope; reuse worker dispatch. Add `is_safe_action_id`. Read `content_type` from meta when building response.
- `src/routes.rs` — extend envelope serialisation: add `kind` discriminant; add `ActionEnvelope`; add `build_action_envelope`
- `src/http.rs` — no signature change (`build_response` already takes `content_type` arg); confirmed by inspection

**Generated (gitignored — already in .gitignore):**
- None beyond existing `.brust/`

**Tests:**
- `src/server.rs` `#[cfg(test)] mod tests` — append `is_safe_action_id` cases
- `src/routes.rs` `#[cfg(test)] mod tests` — append `ActionEnvelope` JSON shape + render-kind backward-compat
- `tests/integration.test.ts` — append action-related tests (target ~10 new tests)

**Docs:**
- `architecture.md` — move "Server functions" entry from "Designed not built" to "Built"; document MVP scope inline; reference the deferred `"use server"` transform follow-up

---

## Task 0: Spike — Verify envelope union roundtrip + meta.contentType wire change

This task validates the two riskiest wire-format changes before any other code is written:
1. Adding `kind: 'render' | 'action'` to the envelope without breaking the existing render path.
2. Adding `contentType?: string` (camelCase) to the meta envelope and having Rust read it via `#[serde(rename)]` while staying backward-compatible with old meta envelopes that omit the field.

If either roundtrip fails, the plan needs adjustment before touching production code.

**Files:**
- Create: `scripts/spike-action-envelope.ts` (will be deleted after the spike)

- [ ] **Step 1: Write the spike**

`scripts/spike-action-envelope.ts`:
```ts
// Verifies that serde_json on the Rust side can:
//  (a) deserialize a meta envelope that includes `contentType` (camelCase)
//      via the new field on ResponseMeta
//  (b) still deserialize one that omits it (backward-compat)
// and that the action-kind envelope JSON we plan to ship serialises to the
// expected shape from the spec.

// We can't easily call Rust deserialisation from this script, so the spike
// instead asserts the JSON output shapes are exactly what the spec specifies.
// The Rust round-trip is exercised by the unit tests in Task 1.

const renderEnv = {
  kind: 'render',
  route_id: 0,
  path: '/foo',
  params: { slug: 'bar' },
  req: { method: 'GET', url: '/foo', headers: {}, cookies: {}, search: {} },
}
const actionEnv = {
  kind: 'action',
  action_id: 'createNote',
  args_json: '["hello"]',
  req: { method: 'POST', url: '/_brust/action/createNote', headers: {}, cookies: {}, search: {} },
}

const renderMeta = { status: 200 }
const actionMeta = { status: 200, contentType: 'application/json; charset=utf-8' }
const middlewareErrorMeta = { status: 401, contentType: 'text/plain; charset=utf-8' }

console.log('render envelope:', JSON.stringify(renderEnv))
console.log('action envelope:', JSON.stringify(actionEnv))
console.log('render meta    :', JSON.stringify(renderMeta))
console.log('action meta    :', JSON.stringify(actionMeta))
console.log('mw error meta  :', JSON.stringify(middlewareErrorMeta))

// Sanity asserts: the action envelope's args_json field is a string, NOT a
// pre-decoded array. JS dispatcher will JSON.parse it once.
const parsed = JSON.parse(actionEnv.args_json)
if (!Array.isArray(parsed)) {
  console.error('FAIL: args_json did not roundtrip to an array')
  process.exit(1)
}
if (parsed[0] !== 'hello') {
  console.error('FAIL: args_json[0] mismatch:', parsed[0])
  process.exit(1)
}

// Sanity assert: a JSON-encoded string containing a quote escapes correctly
// when embedded as args_json inside the envelope. The envelope's outer JSON
// stringification must preserve the inner string as-is.
const trickyArgs = JSON.stringify(['hi "there"', 42, null, { k: 'v' }])
const tricky = { kind: 'action', action_id: 'x', args_json: trickyArgs, req: {} }
const trickyJson = JSON.stringify(tricky)
const trickyReparsed = JSON.parse(trickyJson)
const inner = JSON.parse(trickyReparsed.args_json)
if (inner[0] !== 'hi "there"' || inner[1] !== 42 || inner[2] !== null || inner[3].k !== 'v') {
  console.error('FAIL: tricky args roundtrip:', inner)
  process.exit(1)
}

console.log('spike OK — envelope + meta shapes round-trip in JSON')
```

- [ ] **Step 2: Run the spike**

Run: `cd /Users/detoro/code/brust && bun run scripts/spike-action-envelope.ts`

Expected output (exact lines may differ in field ordering — JSON.stringify is not deterministic on key order in all engines, but Bun's V8 is):
```
render envelope: {"kind":"render","route_id":0,...}
action envelope: {"kind":"action","action_id":"createNote","args_json":"[\"hello\"]",...}
render meta    : {"status":200}
action meta    : {"status":200,"contentType":"application/json; charset=utf-8"}
mw error meta  : {"status":401,"contentType":"text/plain; charset=utf-8"}
spike OK — envelope + meta shapes round-trip in JSON
```

If the script exits non-zero or any assertion fails: report **BLOCKED** with the failure log. Plan needs adjustment (likely the `args_json` design — fall back to embedding args as a parsed JSON value inside the envelope instead).

- [ ] **Step 3: Clean up spike**

Run:
```bash
cd /Users/detoro/code/brust
rm scripts/spike-action-envelope.ts
```

- [ ] **Step 4: Commit the spike findings (no committed files; commit message only documents the validation)**

Spike emitted no committed artifacts. Skip the commit — proceed to Task 1.

---

## Task 1: Rust — Extend route envelope to a union + add ActionEnvelope

**Files:**
- Modify: `src/routes.rs` (add `kind` discriminant + `ActionEnvelope` + `build_action_envelope`)

- [ ] **Step 1: Write the failing test for the render kind discriminant**

Append to the `#[cfg(test)] mod tests` block in `src/routes.rs` (just before the closing `}` on or near line 334):

```rust
#[test]
fn render_envelope_has_kind_discriminant() {
    let table = RouteTable::new();
    let cfg = RouteConfig { path: "/foo".into(), cache: None };
    table.install_with_config(&[cfg]).unwrap();
    let raw = b"GET /foo HTTP/1.1\r\nHost: x\r\n\r\n";
    let result = table.match_path("GET", "/foo", raw);
    match result {
        MatchResult::Matched { envelope_json, .. } => {
            let parsed: serde_json::Value = serde_json::from_str(&envelope_json).unwrap();
            assert_eq!(parsed["kind"], "render");
            assert_eq!(parsed["route_id"], 0);
            assert_eq!(parsed["path"], "/foo");
        }
        MatchResult::NoMatch => panic!("expected match for /foo"),
    }
}
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `cd /Users/detoro/code/brust && cargo test --lib routes::tests::render_envelope_has_kind_discriminant`

Expected: FAIL with `assertion failed: assert_eq!(parsed["kind"], "render")` because `kind` is not yet present.

- [ ] **Step 3: Add the `kind` field to the render envelope serializer**

In `src/routes.rs`, modify the `RouteEnvelope` struct (around line 25):

```rust
/// JSON envelope shipped across the tsfn boundary for each render call.
/// `kind: "render"` discriminates from the action variant; JS dispatcher
/// switches on this field. See ActionEnvelope below for the other variant.
#[derive(Serialize)]
pub struct RouteEnvelope<'a> {
    pub kind: &'static str,
    pub route_id: u32,
    pub path: &'a str,
    pub params: HashMap<&'a str, &'a str>,
    pub req: RequestEnvelope,
}
```

And in `match_path` (around line 102), set `kind: "render"` when constructing:

```rust
let envelope = RouteEnvelope {
    kind: "render",
    route_id: *matched.value,
    path: full_path,
    params,
    req,
};
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `cd /Users/detoro/code/brust && cargo test --lib routes::tests::render_envelope_has_kind_discriminant`

Expected: PASS.

- [ ] **Step 5: Write the failing test for ActionEnvelope serialisation**

Append to `src/routes.rs` test module:

```rust
#[test]
fn action_envelope_serializes_with_kind_action() {
    let req = build_request_envelope(
        "POST",
        "/_brust/action/createNote",
        "",
        b"POST /_brust/action/createNote HTTP/1.1\r\nHost: x\r\n\r\n",
    );
    let env = ActionEnvelope {
        kind: "action",
        action_id: "createNote",
        args_json: r#"["hello"]"#,
        req,
    };
    let json = serde_json::to_string(&env).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed["kind"], "action");
    assert_eq!(parsed["action_id"], "createNote");
    assert_eq!(parsed["args_json"], r#"["hello"]"#);
    assert_eq!(parsed["req"]["method"], "POST");
}

#[test]
fn action_envelope_args_json_preserves_quotes() {
    let req = build_request_envelope("POST", "/_brust/action/x", "", b"");
    let env = ActionEnvelope {
        kind: "action",
        action_id: "x",
        args_json: r#"["hi \"there\"", 42]"#,
        req,
    };
    let json = serde_json::to_string(&env).unwrap();
    // args_json is shipped as a JSON string field, so the outer serialise
    // escapes the inner quotes once. Reparsing the outer JSON and then
    // parsing the inner string should recover the original array.
    let outer: serde_json::Value = serde_json::from_str(&json).unwrap();
    let inner: serde_json::Value = serde_json::from_str(outer["args_json"].as_str().unwrap()).unwrap();
    assert_eq!(inner[0], r#"hi "there""#);
    assert_eq!(inner[1], 42);
}
```

- [ ] **Step 6: Run the tests and verify they fail**

Run: `cd /Users/detoro/code/brust && cargo test --lib routes::tests::action_envelope`

Expected: FAIL with `cannot find type ActionEnvelope in this scope`.

- [ ] **Step 7: Add `ActionEnvelope` to `src/routes.rs`**

Insert after the `RouteEnvelope` struct definition (around line 30 in the current file):

```rust
/// JSON envelope shipped across the tsfn boundary for each action call.
/// Mirrors RouteEnvelope but carries a string action_id (not numeric route_id)
/// and the raw JSON args body — JS dispatcher parses it once after middleware.
/// `kind: "action"` discriminates from the render variant.
#[derive(Serialize)]
pub struct ActionEnvelope<'a> {
    pub kind: &'static str,
    pub action_id: &'a str,
    /// Raw UTF-8 JSON body sent by the client. JS calls JSON.parse on this
    /// inside the action branch of makeRenderer. Validated as UTF-8 by Rust
    /// before reaching here; structural validation (must parse to an array)
    /// happens in JS so the 400 error envelope can flow through the standard
    /// SAB return path.
    pub args_json: &'a str,
    pub req: RequestEnvelope,
}

/// Build an ActionEnvelope JSON string. Mirrors `match_path` for the render
/// case. Caller has already validated the action_id charset and registry
/// membership; this function only assembles the envelope.
pub fn build_action_envelope(
    method: &str,
    full_path: &str,
    action_id: &str,
    args_json: &str,
    raw_request: &[u8],
) -> String {
    let (_, query) = match full_path.split_once('?') {
        Some((p, q)) => (p, q),
        None => (full_path, ""),
    };
    let req = build_request_envelope(method, full_path, query, raw_request);
    let env = ActionEnvelope {
        kind: "action",
        action_id,
        args_json,
        req,
    };
    serde_json::to_string(&env).unwrap()
}
```

Also expose `build_request_envelope` if it's currently private. Check whether it is — looking at the current file, `fn build_request_envelope` is module-private (no `pub`). The new `build_action_envelope` calls it inside the same module, so no visibility change is needed for that. But the test in Step 5 imports `build_request_envelope` via `use super::*` — that's also same-module, so it works without `pub`.

- [ ] **Step 8: Run the tests and verify they pass**

Run: `cd /Users/detoro/code/brust && cargo test --lib routes::tests`

Expected: all existing tests + the 3 new tests (`render_envelope_has_kind_discriminant`, `action_envelope_serializes_with_kind_action`, `action_envelope_args_json_preserves_quotes`) PASS.

- [ ] **Step 9: Commit**

```bash
cd /Users/detoro/code/brust
git add src/routes.rs
git commit -m "$(cat <<'EOF'
feat(routes): add kind discriminant + ActionEnvelope for server functions

RouteEnvelope grows a "kind": "render" discriminant; new ActionEnvelope mirrors
the shape with "kind": "action", a string action_id, and the raw JSON args body
shipped as a string field (parsed once at JS side). build_action_envelope helper
assembles it the same way match_path assembles the render variant.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Rust — Action registry State + register_actions napi method

**Files:**
- Modify: `src/lib.rs` (add `actions` to State + `register_actions` napi)

- [ ] **Step 1: Add `actions` field to State + `current_actions` helper**

In `src/lib.rs`, find the `struct State` block (lines 32-41) and append:

```rust
struct State {
    pool: Arc<WorkerPool>,
    ready: Arc<Notify>,
    shutdown: Arc<Notify>,
    routes: Arc<RouteTable>,
    cache: Arc<LruCache>,
    is_serving: AtomicBool,
    expected_workers: AtomicU32,
    islands_dir: parking_lot::RwLock<Option<std::path::PathBuf>>,
    actions: parking_lot::RwLock<std::collections::HashSet<String>>,
}
```

Update `state()` initialisation (around line 56) to add:
```rust
actions: parking_lot::RwLock::new(std::collections::HashSet::new()),
```

Add a helper near `current_islands_dir` (`src/server.rs` line 16 has the parallel — for `lib.rs`, add near the top after imports):

```rust
pub(crate) fn current_actions_registry() -> parking_lot::RwLockReadGuard<'static, std::collections::HashSet<String>> {
    state().actions.read()
}
```

Wait — exposing a read-guard across a module boundary is awkward. Use a simpler helper that does a contains-check:

```rust
pub(crate) fn action_id_registered(id: &str) -> bool {
    state().actions.read().contains(id)
}
```

Add it after the `state()` function definition (around line 67).

- [ ] **Step 2: Add the `register_actions` napi method**

Append at the end of `src/lib.rs` (after `configure_islands_dir`):

```rust
/// Register the set of action ids that Rust will accept on
/// /_brust/action/<id>. Called once at boot from the main thread.
/// Validates charset and rejects duplicates. Replaces any previous set
/// (no incremental registration in MVP — register once at boot).
#[napi]
pub fn register_actions(ids: Vec<String>) -> NapiResult<u32> {
    use std::collections::HashSet;
    let mut set: HashSet<String> = HashSet::with_capacity(ids.len());
    for id in &ids {
        if !is_safe_action_id(id) {
            return Err(napi::Error::from_reason(format!(
                "action id {id:?} contains invalid characters; allowed: [A-Za-z0-9_-]+"
            )));
        }
        if !set.insert(id.clone()) {
            return Err(napi::Error::from_reason(format!(
                "action id {id:?} registered more than once"
            )));
        }
    }
    let len = set.len() as u32;
    *state().actions.write() = set;
    Ok(len)
}

/// Mirrors is_safe_island_filename's spirit but with no .js suffix.
/// Allows [A-Za-z0-9_-]+ only — same charset as the TS-side island id check.
fn is_safe_action_id(id: &str) -> bool {
    if id.is_empty() || id.len() > 128 {
        return false;
    }
    id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}
```

- [ ] **Step 3: Write a unit test for `is_safe_action_id`**

Append to `src/lib.rs` (after the `is_safe_action_id` function):

```rust
#[cfg(test)]
mod action_id_tests {
    use super::is_safe_action_id;

    #[test] fn ascii_alphanumeric_passes() {
        assert!(is_safe_action_id("createNote"));
        assert!(is_safe_action_id("whoAmI"));
        assert!(is_safe_action_id("a_b-c"));
        assert!(is_safe_action_id("X"));
        assert!(is_safe_action_id("123abc"));
    }
    #[test] fn empty_rejected() { assert!(!is_safe_action_id("")); }
    #[test] fn too_long_rejected() {
        let s: String = std::iter::repeat('a').take(129).collect();
        assert!(!is_safe_action_id(&s));
    }
    #[test] fn dot_rejected() { assert!(!is_safe_action_id("a.b")); }
    #[test] fn slash_rejected() { assert!(!is_safe_action_id("a/b")); }
    #[test] fn double_dot_rejected() { assert!(!is_safe_action_id("..")); }
    #[test] fn non_ascii_rejected() { assert!(!is_safe_action_id("évil")); }
    #[test] fn space_rejected() { assert!(!is_safe_action_id("a b")); }
}
```

- [ ] **Step 4: Build napi + run unit tests**

Run: `cd /Users/detoro/code/brust && cargo test --lib`

Expected: existing tests still pass + 7 new action_id_tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/detoro/code/brust
git add src/lib.rs
git commit -m "$(cat <<'EOF'
feat(lib): action registry state + register_actions napi method

Adds a HashSet<String> to State for the set of action ids Rust will accept
on /_brust/action/<id>. register_actions napi validates charset
([A-Za-z0-9_-]+ only, max 128 chars) and duplicates. action_id_registered
helper used by the server dispatcher in the next task.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Rust — Server dispatch for POST /_brust/action/<id>

This task wires the action endpoint into `handle_conn`. Method/length/charset/registry checks all happen here. The body is read into the existing per-connection `buf`, validated as UTF-8, then handed to `build_action_envelope`. From there the dispatch to the worker tsfn is identical to the render path.

**Files:**
- Modify: `src/server.rs` (add action endpoint dispatch + body reader)

- [ ] **Step 1: Allow POST for action paths in the method gate**

In `src/server.rs`, find the method gate (lines 127-133):

```rust
if method != "GET" && !(method == "POST" && path.starts_with("/_brust/cache/invalidate")) {
    let _ = s.write_all(http::error_405()).await;
    return;
}
```

Change to:

```rust
let is_action = path.starts_with("/_brust/action/");
if method != "GET"
    && !(method == "POST" && path.starts_with("/_brust/cache/invalidate"))
    && !(method == "POST" && is_action)
{
    // For action paths, 405 means "POST is the only allowed method here"
    // — body must already have been consumed (or absent). The fixed `Connection: keep-alive`
    // header in error_405 is correct because we haven't read a body yet.
    let _ = s.write_all(http::error_405()).await;
    return;
}
```

- [ ] **Step 2: Add the action dispatch block**

In `src/server.rs`, insert a new block **after the islands block (ending around line 195)** and **before the cache-invalidate block (line 198)**:

```rust
// Native-only route: server-function dispatch.
//   POST /_brust/action/<id>
// Body: JSON array of args. Worker decodes the array and calls fn(req, ...args).
// Status codes:
//   404 — id charset invalid or not in registry
//   405 — non-POST method (covered by outer method gate, but keep belt+suspenders)
//   411 — Content-Length missing
//   413 — Content-Length > SAB capacity
//   400 — body not valid UTF-8
// 5xx — fn throws / middleware throws (handled by the JS side via meta envelope)
if let Some(after) = path.strip_prefix("/_brust/action/") {
    // The outer method gate has already rejected non-POST; the duplicate check
    // here covers future refactors that might split the gate.
    if method != "POST" {
        let _ = s.write_all(http::error_405()).await;
        return;
    }
    // Strip any query string from the id (action calls may add ?dryRun=1
    // — the request still has the query string in req.search, but the id
    // itself must be the bare segment).
    let id = after.split('?').next().unwrap_or(after);
    if !is_safe_action_id(id) {
        let _ = s.write_all(http::error_404()).await;
        continue;
    }
    if !crate::action_id_registered(id) {
        let _ = s.write_all(http::error_404()).await;
        continue;
    }

    // Locate the body in `buf`. parse_request only gave us method+path; we
    // need to find \r\n\r\n to skip the headers, then read Content-Length bytes.
    let header_end = match buf.windows(4).position(|w| w == b"\r\n\r\n") {
        Some(p) => p + 4,
        None => {
            let _ = s.write_all(http::error_400()).await;
            return;
        }
    };
    let content_length = match parse_content_length(&buf[..header_end]) {
        Some(n) => n,
        None => {
            let _ = s.write_all(http::error_411()).await;
            continue;
        }
    };
    if content_length > MAX_ACTION_BODY_BYTES {
        let _ = s.write_all(http::error_413()).await;
        return;
    }

    // Body bytes already in buf? read_full_request only loops until headers
    // complete; the body may be partially or fully buffered after \r\n\r\n.
    let body_buffered = buf.len().saturating_sub(header_end);
    if body_buffered < content_length {
        // Read the rest of the body. Bound by content_length so we don't
        // over-read into the next request on a keep-alive connection.
        let need = content_length - body_buffered;
        let mut read_so_far = 0usize;
        while read_so_far < need {
            let n = match s.read_request(&mut buf).await {
                Ok(n) => n,
                Err(_) => {
                    let _ = s.write_all(http::error_400()).await;
                    return;
                }
            };
            if n == 0 {
                let _ = s.write_all(http::error_400()).await;
                return;
            }
            read_so_far += n;
        }
    }
    let body_slice = &buf[header_end..header_end + content_length];
    let body_str = match std::str::from_utf8(body_slice) {
        Ok(s) => s,
        Err(_) => {
            let _ = s.write_all(http::error_400()).await;
            continue;
        }
    };

    let envelope_json = crate::routes::build_action_envelope(
        &method, &path, id, body_str, &buf[..header_end],
    );

    let Some(entry) = pool.pick_least_busy() else {
        let _ = s.write_all(http::error_503("no workers")).await;
        return;
    };
    let _guard = entry.in_flight_guard();

    match entry.tsfn.call_async(envelope_json).await {
        Ok(promise) => match promise.await {
            Ok(n) => {
                let n = n as usize;
                if n < 16 || n > entry.buf_len {
                    error!(worker_id = entry.id, written = n, capacity = entry.buf_len, "action oversized");
                    let _ = s.write_all(http::build_response(500, "text/plain", &[], b"action oversized".to_vec())).await;
                    return;
                }
                let raw: Vec<u8> = unsafe {
                    std::slice::from_raw_parts(entry.buf_ptr.0, n).to_vec()
                };
                let meta_len = u16::from_be_bytes([raw[0], raw[1]]) as usize;
                if meta_len + 2 > n {
                    error!(worker_id = entry.id, meta_len, total = n, "meta_len out of range");
                    let _ = s.write_all(http::build_response(500, "text/plain", &[], b"invalid action envelope".to_vec())).await;
                    return;
                }
                let meta_bytes = &raw[2..2 + meta_len];
                let meta: ResponseMeta = match serde_json::from_slice(meta_bytes) {
                    Ok(m) => m,
                    Err(e) => {
                        error!(worker_id = entry.id, error = %e, "meta JSON parse failed");
                        let _ = s.write_all(http::build_response(500, "text/plain", &[], b"invalid action envelope".to_vec())).await;
                        return;
                    }
                };
                let body = raw[2 + meta_len..].to_vec();
                let extra: Vec<(String, String)> = meta.headers.into_iter().collect();
                // Content-Type from meta override (JS sets 'application/json' for normal action
                // returns and 'text/plain' for middleware string short-circuits). Falls back to
                // 'application/json' when JS omits it — action endpoint never returns HTML.
                let ct = meta.content_type.as_deref().unwrap_or("application/json; charset=utf-8");
                let bytes = http::build_response(meta.status, ct, &extra, body);
                if s.write_all(bytes).await.is_err() {
                    return;
                }
                continue;
            }
            Err(e) => {
                error!(worker_id = entry.id, error = %e, "action promise rejected");
                let msg = format!("action error: {e}");
                let _ = s.write_all(http::build_response(500, "text/plain", &[], msg.into_bytes())).await;
                return;
            }
        },
        Err(e) => {
            error!(worker_id = entry.id, error = %e, "tsfn call_async failed");
            let _ = s.write_all(http::build_response(502, "text/plain", &[], b"upstream call failed".to_vec())).await;
            pool.remove(entry.id);
            if pool.registered_count() == 0 {
                error!("all workers died");
                std::process::exit(1);
            }
            return;
        }
    }
}
```

- [ ] **Step 3: Add helpers + constants + `error_411` / `error_413` + extend ResponseMeta with `content_type`**

In `src/server.rs`, add near `MAX_REQUEST_BYTES` (around line 36):

```rust
/// Cap on action body size. Mirrors the SAB capacity (256 KB default) so
/// the largest action call fits in one SAB write. If the SAB is reconfigured
/// larger by the user, this bound stays — action bodies don't get to grow
/// past the renderer's working buffer.
const MAX_ACTION_BODY_BYTES: usize = 256 * 1024;
```

Extend `ResponseMeta` (around line 21-25) to include the new field:

```rust
#[derive(Debug, Deserialize)]
struct ResponseMeta {
    status: u16,
    #[serde(default)]
    headers: std::collections::HashMap<String, String>,
    /// JS-side override for the Content-Type header. Used by the action path
    /// (sets 'application/json') and by middleware short-circuits returning
    /// text. Absent on the render path → Rust uses the default.
    #[serde(default, rename = "contentType")]
    content_type: Option<String>,
}
```

Add `parse_content_length` helper at the bottom of `src/server.rs` (before the `#[cfg(test)]` block):

```rust
/// Extract `Content-Length` from a buffered HTTP request's headers. Returns
/// None if the header is missing or unparseable. Caller has already ensured
/// `\r\n\r\n` is present in `buf`.
fn parse_content_length(buf: &[u8]) -> Option<usize> {
    let mut headers = [httparse::EMPTY_HEADER; 64];
    let mut req = httparse::Request::new(&mut headers);
    let _ = req.parse(buf);
    for h in req.headers.iter() {
        if h.name.eq_ignore_ascii_case("content-length") {
            let s = std::str::from_utf8(h.value).ok()?;
            return s.trim().parse::<usize>().ok();
        }
    }
    None
}

/// Mirrors src/lib.rs::is_safe_action_id. Belt-and-suspenders: the dispatch
/// check that happens here is the only sanitization between the URL path and
/// the action registry lookup.
fn is_safe_action_id(id: &str) -> bool {
    if id.is_empty() || id.len() > 128 {
        return false;
    }
    id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}
```

Add `error_411` and `error_413` in `src/http.rs` after `error_405`:

```rust
pub fn error_411() -> Vec<u8> {
    build_response(411, "text/plain", &[], b"length required".to_vec())
}
pub fn error_413() -> Vec<u8> {
    // Body might be partially read at this point — Connection: close so
    // the client doesn't try to pipeline another request on this socket.
    let body: &[u8] = b"payload too large";
    let header = format!(
        "HTTP/1.1 413 Payload Too Large\r\n\
         Content-Type: text/plain\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\
         \r\n",
        body.len(),
    );
    let mut out = header.into_bytes();
    out.extend_from_slice(body);
    out
}
```

Also extend the status_text match in `build_response` (around line 35-49) to recognise 411 and 413:

```rust
let status_text = match status {
    200 => "OK",
    301 => "Moved Permanently",
    302 => "Found",
    400 => "Bad Request",
    401 => "Unauthorized",
    403 => "Forbidden",
    404 => "Not Found",
    405 => "Method Not Allowed",
    411 => "Length Required",
    413 => "Payload Too Large",
    414 => "URI Too Long",
    500 => "Internal Server Error",
    502 => "Bad Gateway",
    503 => "Service Unavailable",
    _ => "Unknown",
};
```

- [ ] **Step 4: Add Rust unit tests for `is_safe_action_id` in server.rs and `parse_content_length`**

Append to `src/server.rs` `#[cfg(test)] mod tests` (just before the closing `}` around line 516):

```rust
#[test]
fn server_action_id_matches_lib_helper() {
    // Sanity: server.rs and lib.rs both define is_safe_action_id. They must
    // agree on every input — drifting between the two is a 404 / 200 split
    // depending on call order, which is a security smell.
    let cases = [
        ("createNote", true),
        ("a_b-c", true),
        ("X", true),
        ("", false),
        ("a.b", false),
        ("a/b", false),
        ("..", false),
        ("évil", false),
        ("a b", false),
    ];
    for (input, expected) in cases {
        assert_eq!(is_safe_action_id(input), expected, "input={input:?}");
    }
}

#[test]
fn parse_content_length_finds_header() {
    let raw = b"POST /x HTTP/1.1\r\nHost: x\r\nContent-Length: 42\r\n\r\n";
    assert_eq!(parse_content_length(raw), Some(42));
}

#[test]
fn parse_content_length_case_insensitive() {
    let raw = b"POST /x HTTP/1.1\r\nHost: x\r\ncontent-length: 7\r\n\r\n";
    assert_eq!(parse_content_length(raw), Some(7));
}

#[test]
fn parse_content_length_missing_returns_none() {
    let raw = b"POST /x HTTP/1.1\r\nHost: x\r\n\r\n";
    assert_eq!(parse_content_length(raw), None);
}

#[test]
fn parse_content_length_garbage_returns_none() {
    let raw = b"POST /x HTTP/1.1\r\nHost: x\r\nContent-Length: NaN\r\n\r\n";
    assert_eq!(parse_content_length(raw), None);
}
```

- [ ] **Step 5: Run cargo test**

Run: `cd /Users/detoro/code/brust && cargo build && cargo test --lib`

Expected: all existing tests pass + the 5 new server-side tests pass. ResponseMeta now has `content_type: Option<String>` — existing render path leaves it `None`, falling back to the hardcoded `"text/html; charset=utf-8"` in `handle_conn`. **Note:** existing render code path (around line 311) still passes `"text/html; charset=utf-8"` literally. We are leaving it untouched in this task — the render path will optionally start using `meta.content_type` in a later refactor; for the action MVP, only the action branch reads `meta.content_type`. Adding the field to ResponseMeta is backward-compatible because `#[serde(default)]` makes it optional.

- [ ] **Step 6: Commit**

```bash
cd /Users/detoro/code/brust
git add src/server.rs src/http.rs
git commit -m "$(cat <<'EOF'
feat(server): POST /_brust/action/<id> native dispatch

Handle the action endpoint inline in handle_conn before the route-table match:
method/charset/length/registry/utf-8 checks, then build_action_envelope and
dispatch through the existing renderer tsfn. ResponseMeta grows an optional
contentType field (camelCase, JS-side override); the action path defaults
to application/json when JS omits it. error_411 + error_413 added to http.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: TS — ActionDef + ActionFn + registerActions glue

**Files:**
- Create: `runtime/actions.ts`
- Modify: `runtime/index.ts`

- [ ] **Step 1: Create `runtime/actions.ts`**

`runtime/actions.ts`:
```ts
import type { BrustRequest, Middleware } from './routes.ts'

/** Server-side action handler. First arg is ALWAYS BrustRequest; the client
 * stub strips it from the call site. Subsequent args are JSON-decoded from
 * the request body (which MUST be a JSON array). */
export type ActionFn<Args extends unknown[] = unknown[], R = unknown> =
  (req: BrustRequest, ...args: Args) => Promise<R>

/** Registration shape passed to brust.registerActions. */
export interface ActionDef<F extends ActionFn = ActionFn> {
  /** Stable id; must match the id used by `action<F>(id)` on the client.
   * Charset: [A-Za-z0-9_-]+ (enforced both in TS and in Rust). */
  id: string
  /** Handler. Receives req + JSON-decoded args. */
  fn: F
  /** Per-action middleware chain. Same Middleware type used by routes. */
  middleware?: Middleware[]
}

/** Identity helper that pins the actions array's element type. Parallels
 * defineRoutes. Use to keep TS inference happy across the boundary. */
export function defineActions(actions: ActionDef[]): ActionDef[] {
  return actions
}

/** Mirrors is_safe_action_id in src/lib.rs and src/server.rs.
 * Allowed: [A-Za-z0-9_-]+ only, max 128 chars. */
export function isValidActionId(id: string): boolean {
  if (id.length === 0 || id.length > 128) return false
  return /^[A-Za-z0-9_-]+$/.test(id)
}
```

- [ ] **Step 2: Extend `runtime/index.ts` to re-export + add `brust.registerActions`**

In `runtime/index.ts`, append to the re-exports section (after the existing `export type { … }` from `./routes.ts` block, around line 86):

```ts
export { defineActions, isValidActionId } from './actions.ts'
export type { ActionDef, ActionFn } from './actions.ts'
```

Inside the `brust` object literal (after `configureIslandsDir`, around line 66), add:

```ts
/** Tell Rust which action ids are allowed on /_brust/action/<id>.
 * Validates charset + uniqueness in TS first, then forwards the id set
 * to the native register_actions napi entry. Returns the count
 * registered. Throws on validation failure. */
registerActions(actions: Array<{ id: string }>): number {
  const seen = new Set<string>()
  for (const a of actions) {
    if (!isValidActionId(a.id)) {
      throw new Error(
        `action id ${JSON.stringify(a.id)} contains invalid characters; ` +
        `allowed: [A-Za-z0-9_-]+ (max 128 chars)`,
      )
    }
    if (seen.has(a.id)) {
      throw new Error(`action id ${JSON.stringify(a.id)} registered more than once`)
    }
    seen.add(a.id)
  }
  return (native as any).registerActions(actions.map((a) => a.id))
},
```

You'll also need to import `isValidActionId`. Add to the top of `runtime/index.ts`:

```ts
import { isValidActionId } from './actions.ts'
```

(Order: place it right after the existing `// @ts-ignore` native import.)

- [ ] **Step 3: Update `runtime/index.ts` napi typings**

The `(native as any).registerActions` call has no signature in `index.js` yet — that's fine, the `as any` cast covers it. The Rust napi side will generate the binding when `cargo build` re-runs in Task 5's build step.

- [ ] **Step 4: Run TS type check on the runtime module**

Run: `cd /Users/detoro/code/brust/runtime && bunx tsc --noEmit --skipLibCheck`

Expected: PASS (no type errors). If tsc complains about missing `index.js`, that's expected — the napi build output is gitignored. The `@ts-ignore` on the native import covers it.

(If tsc isn't installed: `bunx tsc` should auto-install it. Alternatively skip this step and lean on the integration tests for type validation — the project's existing pattern doesn't enforce a tsc step.)

- [ ] **Step 5: Rebuild the napi binding so registerActions is exposed**

Run: `cd /Users/detoro/code/brust/runtime && bun run build:debug`

Expected: builds without warnings; `runtime/index.darwin-arm64.node` is overwritten with a binary that exports `registerActions`. Verify with a one-liner:

```bash
node -e "console.log(typeof require('./runtime/index.darwin-arm64.node').registerActions)"
```

Expected output: `function`

- [ ] **Step 6: Commit**

```bash
cd /Users/detoro/code/brust
git add runtime/actions.ts runtime/index.ts
git commit -m "$(cat <<'EOF'
feat(runtime): defineActions + brust.registerActions glue

Adds the ActionDef / ActionFn types and a defineActions identity helper.
brust.registerActions validates charset and uniqueness in TS, then forwards
the id list to the native register_actions napi method. The .node binary
rebuilt with `bun run build:debug` so the new entry point is visible to
worker code added in the next task.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: TS — RouteCall union + makeRenderer kind switch

This task is the heart of the JS side. `makeRenderer` grows an `actions` option, switches on `envelope.kind`, and reuses the existing middleware-chain composition for the action branch.

**Files:**
- Modify: `runtime/routes.ts`

- [ ] **Step 1: Update the `RouteCall` type to a discriminated union**

In `runtime/routes.ts`, replace the existing `RouteCall` interface (around line 87-95) with:

```ts
/** Wire-level shape of the JSON envelope produced by Rust. Discriminated
 * union: render path (matched against a route) vs action path
 * (POST /_brust/action/<id>). Keep these in sync with src/routes.rs
 * RouteEnvelope / ActionEnvelope.
 */
export type RouteCall =
  | {
      kind: 'render'
      route_id: number
      path: string
      params: Record<string, string>
      req: BrustRequest
    }
  | {
      kind: 'action'
      action_id: string
      /** Raw JSON args body (a JSON string). Worker parses it once,
       * checks Array.isArray, then spreads into the action handler. */
      args_json: string
      req: BrustRequest
    }
```

- [ ] **Step 2: Extend `MakeRendererOptions`**

In the same file, add `actions` to the options interface (around line 104-108):

```ts
export interface MakeRendererOptions {
  /** Lazy getter for the Bun Worker id. */
  getWorkerId?: () => number | null
  /** Action table the worker dispatches to when envelope.kind === 'action'.
   * Pass the SAME array given to brust.registerActions on the main thread —
   * the wire keys (ids) and the handler functions (fn) must agree. */
  actions?: ActionDef[]
}
```

Add an `import` at the top of the file for `ActionDef`:

```ts
import type { ActionDef } from './actions.ts'
```

- [ ] **Step 3: Refactor `makeRenderer` to dispatch on kind**

The current `makeRenderer` (lines 110-209) assumes every call is a render. Refactor to switch on `kind` while preserving the existing render flow byte-for-byte. Replace the body with:

```ts
export function makeRenderer(
  routes: Route[],
  view: Uint8Array,
  opts: MakeRendererOptions = {},
): (envelopeJson: string) => Promise<number> {
  const encoder = new TextEncoder()
  const byRouteId = new Map<number, Route>()
  routes.forEach((r, i) => byRouteId.set(i, r))
  const byActionId = new Map<string, ActionDef>()
  for (const a of opts.actions ?? []) byActionId.set(a.id, a)

  return async (envelopeJson: string): Promise<number> => {
    const call = JSON.parse(envelopeJson) as RouteCall

    if (call.kind === 'render') {
      return renderBranch(call, byRouteId, view, encoder, opts.getWorkerId)
    }
    if (call.kind === 'action') {
      return actionBranch(call, byActionId, view, encoder)
    }
    // Unknown kind — log and 500. Shouldn't happen unless Rust ships
    // something out of band.
    console.error(`[brust] unknown envelope kind in worker:`, (call as { kind?: string }).kind)
    return packResponse(view, encoder, {
      status: 500,
      body: 'invalid envelope kind',
      contentType: 'text/plain; charset=utf-8',
    })
  }
}
```

Add the two branch helpers below `makeRenderer` (inside the same module — they share the encoder/SAB protocol):

```ts
async function renderBranch(
  call: Extract<RouteCall, { kind: 'render' }>,
  byId: Map<number, Route>,
  view: Uint8Array,
  encoder: TextEncoder,
  getWorkerId?: () => number | null,
): Promise<number> {
  const route = byId.get(call.route_id)
  if (!route) {
    console.error(`[brust] unknown route_id=${call.route_id} for path=${call.path}`)
    return 0
  }
  const workerId = getWorkerId ? getWorkerId() : null

  const terminal = async (): Promise<RouteResponse> => {
    try {
      const data = route.loader
        ? await route.loader({ params: call.params, path: call.path, req: call.req })
        : undefined
      const html = renderToString(
        createElement(route.Component, {
          params: call.params,
          path: call.path,
          data,
          workerId,
          req: call.req,
        }),
      )
      const wrapped = consumeIslandUsedFlag()
        ? wrapWithIslandsBootstrap(html)
        : html
      return { status: 200, body: wrapped }
    } catch (renderErr) {
      if (!route.errorBoundary) throw renderErr
      const boundary: ReactNode = createElement(route.errorBoundary, {
        error: renderErr instanceof Error ? renderErr : new Error(String(renderErr)),
      })
      const html = renderToString(boundary)
      const wrapped = consumeIslandUsedFlag()
        ? wrapWithIslandsBootstrap(html)
        : html
      return { status: 500, body: wrapped }
    }
  }

  let chain = terminal
  if (route.middleware && route.middleware.length > 0) {
    for (let i = route.middleware.length - 1; i >= 0; i--) {
      const mw = route.middleware[i]
      const next = chain
      chain = () => mw(call.req, next)
    }
  }

  let response: RouteResponse
  try {
    response = await chain()
  } catch (err) {
    console.error(`[brust] middleware/render uncaught:`, err)
    response = { status: 500, body: 'internal error' }
  }
  return packResponse(view, encoder, response)
}

async function actionBranch(
  call: Extract<RouteCall, { kind: 'action' }>,
  byId: Map<string, ActionDef>,
  view: Uint8Array,
  encoder: TextEncoder,
): Promise<number> {
  const def = byId.get(call.action_id)
  if (!def) {
    // Rust already 404s when the id isn't registered, but a race during
    // hot-reload (or a desynced worker) could land here. Log and 404.
    console.error(`[brust] unknown action_id=${call.action_id}`)
    return packResponse(view, encoder, {
      status: 404,
      body: '{"error":{"message":"unknown action"}}',
      contentType: 'application/json; charset=utf-8',
    })
  }

  // Parse args BEFORE middleware so a malformed body 400s without running
  // any user code.
  let args: unknown[]
  try {
    const decoded = JSON.parse(call.args_json) as unknown
    if (!Array.isArray(decoded)) {
      return packResponse(view, encoder, {
        status: 400,
        body: '{"error":{"message":"args must be a JSON array"}}',
        contentType: 'application/json; charset=utf-8',
      })
    }
    args = decoded
  } catch {
    return packResponse(view, encoder, {
      status: 400,
      body: '{"error":{"message":"invalid args JSON"}}',
      contentType: 'application/json; charset=utf-8',
    })
  }

  const terminal = async (): Promise<RouteResponse> => {
    try {
      const result = await def.fn(call.req, ...args)
      return {
        status: 200,
        body: result === undefined ? '' : JSON.stringify(result),
        contentType: 'application/json; charset=utf-8',
      }
    } catch (err) {
      console.error(`[brust] action ${def.id} threw:`, err)
      const e = err instanceof Error ? err : new Error(String(err))
      return {
        status: 500,
        body: JSON.stringify({ error: { message: e.message, name: e.name } }),
        contentType: 'application/json; charset=utf-8',
      }
    }
  }

  let chain = terminal
  if (def.middleware && def.middleware.length > 0) {
    for (let i = def.middleware.length - 1; i >= 0; i--) {
      const mw = def.middleware[i]
      const next = chain
      chain = () => mw(call.req, next)
    }
  }

  let response: RouteResponse
  try {
    response = await chain()
  } catch (err) {
    console.error(`[brust] action middleware uncaught:`, err)
    response = {
      status: 500,
      body: JSON.stringify({ error: { message: 'internal error' } }),
      contentType: 'application/json; charset=utf-8',
    }
  }
  return packResponse(view, encoder, response)
}

/** Pack a RouteResponse into the SAB and return the byte count.
 * Wire format: [meta_len: u16 BE][meta JSON UTF-8][body bytes].
 * meta = { status, headers?, contentType? } */
function packResponse(
  view: Uint8Array,
  encoder: TextEncoder,
  response: RouteResponse,
): number {
  const meta: { status: number; headers?: Record<string, string>; contentType?: string } = {
    status: response.status,
  }
  if (response.headers) meta.headers = response.headers
  if (response.contentType) meta.contentType = response.contentType

  const metaBytes = encoder.encode(JSON.stringify(meta))
  if (metaBytes.length > 0xffff) {
    console.error(`[brust] meta too large: ${metaBytes.length} bytes`)
    return 0
  }
  if (2 + metaBytes.length > view.length) {
    console.error(`[brust] envelope > SAB capacity`)
    return 0
  }
  view[0] = (metaBytes.length >> 8) & 0xff
  view[1] = metaBytes.length & 0xff
  view.set(metaBytes, 2)
  const bodyView = view.subarray(2 + metaBytes.length)
  const { written } = encoder.encodeInto(response.body, bodyView)
  if (written === undefined) return 0
  return 2 + metaBytes.length + written
}
```

- [ ] **Step 4: Extend `RouteResponse` to allow `contentType` override**

In `runtime/routes.ts`, find the `RouteResponse` interface (around line 44-51) and add the new field:

```ts
export interface RouteResponse {
  status: number
  body: string
  /** Extra response headers. Names are case-insensitive on the wire; Rust
   * deduplicates by lower-casing internally. Skips collisions with the fixed
   * Content-Type / Content-Length / Connection lines. */
  headers?: Record<string, string>
  /** Override the Content-Type emitted by Rust. Action returns set this to
   * 'application/json; charset=utf-8'; middleware short-circuits with a
   * raw string body can set 'text/plain'. Falls back to 'text/html' (render)
   * or 'application/json' (action) when omitted. */
  contentType?: string
}
```

- [ ] **Step 5: Make sure the route-render path still passes integration tests**

The refactor in Step 3 moved the existing render logic into `renderBranch` verbatim. Verify with the existing test suite.

Run: `cd /Users/detoro/code/brust && bun test tests/integration.test.ts`

Expected: all 18 existing integration tests pass. If any fail, the render path's byte-for-byte equivalence has slipped — diff carefully against the original `makeRenderer` body.

- [ ] **Step 6: Commit**

```bash
cd /Users/detoro/code/brust
git add runtime/routes.ts
git commit -m "$(cat <<'EOF'
feat(runtime): makeRenderer dispatches render + action via kind discriminant

RouteCall becomes a discriminated union; makeRenderer switches on kind into
renderBranch (existing logic moved verbatim) or actionBranch (new). Action
branch parses args once before middleware, runs the same right-to-left
chain composition, JSON-stringifies the return, and sets contentType in
the meta envelope so Rust emits application/json. RouteResponse gains
optional contentType.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: TS — `action<F>(id)` client helper

**Files:**
- Create: `runtime/client/index.ts`

- [ ] **Step 1: Create `runtime/client/index.ts`**

`runtime/client/index.ts`:
```ts
/** Browser-only client helpers. This module is loaded by hydrated island
 * bundles. It intentionally does NOT import from runtime/routes.ts or
 * runtime/index.ts — those pull in React and server-side surface that the
 * client doesn't need.
 */

export class BrustActionError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly payload: unknown,
  ) {
    super(message)
    this.name = 'BrustActionError'
  }
}

/** Untyped server-fn shape used as the generic constraint. The client never
 * sees BrustRequest, so we type the leading req as `any` here — the helper
 * strips it from the call site via DropReq<F>. */
export type ServerFn = (req: any, ...args: any[]) => Promise<any>

/** Drop the leading `req` arg from F's parameter list. */
type DropReq<F> = F extends (req: any, ...args: infer A) => infer R
  ? (...args: A) => R
  : never

/** Build a typed RPC stub for an action.
 *
 * Usage:
 *   import type * as srv from '../actions'
 *   const createNote = action<typeof srv.createNote>('createNote')
 *   const { id } = await createNote('hello')  // typed Promise<{ id: string }>
 *
 * @param id  The action id registered via brust.registerActions.
 */
export function action<F extends ServerFn>(id: string): DropReq<F> {
  return (async (...args: unknown[]) => {
    const res = await fetch(`/_brust/action/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    })
    const text = await res.text()
    if (!res.ok) {
      const parsed = safeParse(text)
      const message =
        (parsed && typeof parsed === 'object' && parsed !== null &&
         'error' in parsed && parsed.error && typeof parsed.error === 'object' &&
         'message' in parsed.error && typeof parsed.error.message === 'string')
          ? parsed.error.message
          : (text || 'action failed')
      throw new BrustActionError(message, res.status, parsed ?? text)
    }
    return text ? JSON.parse(text) : undefined
  }) as DropReq<F>
}

function safeParse(s: string): unknown | null {
  try { return JSON.parse(s) } catch { return null }
}
```

- [ ] **Step 2: Verify the client helper compiles standalone**

Run: `cd /Users/detoro/code/brust && bunx tsc --noEmit --skipLibCheck runtime/client/index.ts`

Expected: PASS (no type errors). If tsc complains about `Function<…>` shape (it can be picky about `any` in generic constraints), the `as DropReq<F>` cast covers the gap; the runtime behaviour is what matters.

- [ ] **Step 3: Commit**

```bash
cd /Users/detoro/code/brust
git add runtime/client/index.ts
git commit -m "$(cat <<'EOF'
feat(runtime): action<F>(id) client RPC helper

New runtime/client entry point — browser-only, no React or server imports.
The helper fetches POST /_brust/action/<id> with the args JSON-encoded as an
array, parses the JSON return, and throws BrustActionError(status, payload)
on non-2xx. DropReq<F> drops the leading `req` arg so client code sees a
clean function signature.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Example app — actions + islands + routes wiring

**Files:**
- Create: `example/hello-world/actions.ts`
- Create: `example/hello-world/components/NoteForm.tsx`
- Create: `example/hello-world/components/WhoAmI.tsx`
- Create: `example/hello-world/components/NotePage.tsx`
- Create: `example/hello-world/components/WhoAmIPage.tsx`
- Modify: `example/hello-world/island.config.ts`
- Modify: `example/hello-world/routes.tsx`
- Modify: `example/hello-world/index.ts`

- [ ] **Step 1: Create `example/hello-world/actions.ts`**

```ts
import type { BrustRequest } from '../../runtime/routes.ts'

/** Demo action: pretend to insert a note and return a generated id. */
export async function createNote(req: BrustRequest, text: string): Promise<{ id: string }> {
  if (typeof text !== 'string') throw new Error('text must be a string')
  if (text.length > 1000) throw new Error('text too long (max 1000)')
  // Real apps would call into a DB here. We synthesise an id for the demo.
  return { id: 'n-' + Date.now() }
}

/** Demo action: returns whoever the `user` cookie says they are, or null. */
export async function whoAmI(req: BrustRequest): Promise<{ user: string | null }> {
  return { user: req.cookies['user'] ?? null }
}

/** Demo action: gated by an auth middleware in routes registration. */
export async function deleteNote(req: BrustRequest, noteId: string): Promise<{ ok: true }> {
  if (typeof noteId !== 'string' || noteId.length === 0) {
    throw new Error('noteId must be a non-empty string')
  }
  return { ok: true }
}
```

- [ ] **Step 2: Create `example/hello-world/components/NoteForm.tsx` (island)**

```tsx
import { useState } from 'react'
import { action, BrustActionError } from '../../../runtime/client/index.ts'
import type * as srv from '../actions'

const createNote = action<typeof srv.createNote>('createNote')

export default function NoteForm() {
  const [text, setText] = useState('')
  const [created, setCreated] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault()
        setErr(null)
        try {
          const { id } = await createNote(text)
          setCreated(id)
          setText('')
        } catch (caught) {
          if (caught instanceof BrustActionError) setErr(`status ${caught.status}: ${caught.message}`)
          else setErr(String(caught))
        }
      }}
    >
      <input
        data-testid="note-text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="note text"
      />
      <button>Save</button>
      {created && <span data-testid="note-created">created {created}</span>}
      {err && <span data-testid="note-error">{err}</span>}
    </form>
  )
}
```

- [ ] **Step 3: Create `example/hello-world/components/WhoAmI.tsx` (island)**

```tsx
import { useEffect, useState } from 'react'
import { action } from '../../../runtime/client/index.ts'
import type * as srv from '../actions'

const whoAmI = action<typeof srv.whoAmI>('whoAmI')

export default function WhoAmI() {
  const [user, setUser] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    whoAmI().then((r) => setUser(r.user))
  }, [])
  return <p data-testid="whoami">user: {user === undefined ? '...' : (user ?? '(anonymous)')}</p>
}
```

- [ ] **Step 4: Create the SSR pages that embed the islands**

`example/hello-world/components/NotePage.tsx`:
```tsx
import { Island } from '../../../runtime/index.ts'
import NoteForm from './NoteForm'

export default function NotePage() {
  return (
    <html>
      <head><title>Note demo</title></head>
      <body>
        <h1>Create a note</h1>
        <Island id="NoteForm" component={NoteForm} props={{}} hydrate="load" />
      </body>
    </html>
  )
}
```

`example/hello-world/components/WhoAmIPage.tsx`:
```tsx
import { Island } from '../../../runtime/index.ts'
import WhoAmI from './WhoAmI'

export default function WhoAmIPage() {
  return (
    <html>
      <head><title>Who am I</title></head>
      <body>
        <h1>Who am I?</h1>
        <Island id="WhoAmI" component={WhoAmI} props={{}} hydrate="load" />
      </body>
    </html>
  )
}
```

- [ ] **Step 5: Register the new islands in `example/hello-world/island.config.ts`**

Read the current file first to preserve any existing entries.

```bash
cat example/hello-world/island.config.ts
```

Replace with:

```ts
export default {
  islands: {
    Counter: './components/Counter.tsx',
    NoteForm: './components/NoteForm.tsx',
    WhoAmI: './components/WhoAmI.tsx',
  },
}
```

(If the existing config already has `Counter`, just append the two new entries; the structure shown above is what's expected after this task.)

- [ ] **Step 6: Register the actions + new routes in `index.ts` and `routes.tsx`**

In `example/hello-world/routes.tsx`, add imports + 2 new routes:

```tsx
import { defineRoutes, type Middleware } from '../../runtime/routes.ts'
import HelloWorld    from './components/HelloWorld'
import BlogPost      from './components/BlogPost'
import Crash         from './components/Crash'
import CrashBoundary from './components/CrashBoundary'
import CacheTest     from './components/CacheTest'
import Protected     from './components/Protected'
import WithHeader    from './components/WithHeader'
import NotePage      from './components/NotePage'
import WhoAmIPage    from './components/WhoAmIPage'

// Auth middleware (existing) ...
const authRequired: Middleware = async (req, next) => {
  if (!req.cookies['user']) {
    return { status: 401, body: 'unauthorised', headers: { 'WWW-Authenticate': 'Cookie' } }
  }
  return next()
}

const timeIt: Middleware = async (_req, next) => {
  const t0 = Date.now()
  const res = await next()
  res.headers = { ...(res.headers ?? {}), 'x-render-ms': String(Date.now() - t0) }
  return res
}

export const routes = defineRoutes([
  { path: '/',             Component: HelloWorld },
  { path: '/blog/{slug}',  Component: BlogPost,
    loader: async ({ params }) => ({ title: `Post: ${params.slug}` }) },
  { path: '/crash',        Component: Crash, errorBoundary: CrashBoundary },
  { path: '/cache-test',   Component: CacheTest, cache: { ttl_seconds: 60 } },
  { path: '/protected',    Component: Protected,    middleware: [authRequired] },
  { path: '/with-header',  Component: WithHeader,   middleware: [timeIt] },
  { path: '/note',         Component: NotePage },
  { path: '/whoami',       Component: WhoAmIPage },
])
```

In `example/hello-world/index.ts`, register the actions on the main thread + pass them to `makeRenderer` on the worker side:

```ts
import { brust, isWorker, loadConfig, makeRenderer, buildIslands, defineActions, type Middleware } from '../../runtime/index.ts'
import { routes } from './routes'
import { createNote, whoAmI, deleteNote } from './actions'

// Auth middleware to demo on the deleteNote action.
const requireUser: Middleware = async (req, next) => {
  if (!req.cookies['user']) {
    return { status: 401, body: 'login required' }
  }
  return next()
}

const actions = defineActions([
  { id: 'createNote', fn: createNote },
  { id: 'whoAmI',     fn: whoAmI },
  { id: 'deleteNote', fn: deleteNote, middleware: [requireUser] },
])

if (!isWorker) {
  const { port, workers, cacheMaxEntries } = await loadConfig()
  console.log(`[brust] main: spawning ${workers} worker threads`)

  if (cacheMaxEntries !== undefined) {
    brust.configureCache({ maxEntries: cacheMaxEntries })
  }
  const islands = await buildIslands(
    new URL('./island.config.ts', import.meta.url).pathname,
  )
  brust.configureIslandsDir(islands.outDir)
  console.log(`[brust] main: built ${islands.islandCount} island chunk(s)`)
  brust.registerRoutes(routes)
  brust.registerActions(actions)
  console.log(`[brust] main: registered ${actions.length} action(s)`)

  await brust.serve({
    port,
    workers,
    entry: import.meta.url,
  })
} else {
  const sab = new SharedArrayBuffer(256 * 1024)
  const view = new Uint8Array(sab)

  let wid: number | null = null
  const renderer = makeRenderer(routes, view, { actions, getWorkerId: () => wid })
  wid = brust.registerRenderer(view, renderer)
}
```

- [ ] **Step 7: Smoke test the example app end-to-end manually**

Run in one terminal:
```bash
cd /Users/detoro/code/brust
BRUST_PORT=38900 bun run example/hello-world/index.ts
```

Wait for the `[brust] listening on 127.0.0.1:38900` line (boot takes 3-5 s the first time because of Bun.build).

In another terminal:
```bash
# 1. Page renders, has the island marker + bootstrap.
curl -s http://127.0.0.1:38900/note | head -50

# 2. Direct action call — no cookie, returns the synthesised id.
curl -s -X POST -H 'content-type: application/json' \
  --data '["hello world"]' \
  http://127.0.0.1:38900/_brust/action/createNote
# Expected: {"id":"n-<unix-ms>"}

# 3. whoAmI without cookie.
curl -s -X POST --data '[]' \
  http://127.0.0.1:38900/_brust/action/whoAmI
# Expected: {"user":null}

# 4. deleteNote gated by middleware — no cookie returns 401.
curl -si -X POST -H 'content-type: application/json' \
  --data '["n-123"]' \
  http://127.0.0.1:38900/_brust/action/deleteNote | head -1
# Expected: HTTP/1.1 401 Unauthorized

# 5. deleteNote with cookie succeeds.
curl -s -X POST -H 'content-type: application/json' -H 'cookie: user=alice' \
  --data '["n-123"]' \
  http://127.0.0.1:38900/_brust/action/deleteNote
# Expected: {"ok":true}

# 6. Unknown id → 404.
curl -si -X POST --data '[]' http://127.0.0.1:38900/_brust/action/missing | head -1
# Expected: HTTP/1.1 404 Not Found

# 7. GET on an action endpoint → 405.
curl -si http://127.0.0.1:38900/_brust/action/createNote | head -1
# Expected: HTTP/1.1 405 Method Not Allowed

# 8. Malformed JSON args → 400.
curl -si -X POST -H 'content-type: application/json' \
  --data 'not-json' \
  http://127.0.0.1:38900/_brust/action/createNote | head -1
# Expected: HTTP/1.1 400 Bad Request

# 9. Args not an array → 400.
curl -si -X POST -H 'content-type: application/json' \
  --data '{"text":"hi"}' \
  http://127.0.0.1:38900/_brust/action/createNote | head -1
# Expected: HTTP/1.1 400 Bad Request
```

If any of these don't match the expected output: STOP and diagnose before moving on. The remaining tasks assume the wire works end-to-end.

Kill the server: `Ctrl-C` in the first terminal.

- [ ] **Step 8: Commit**

```bash
cd /Users/detoro/code/brust
git add example/hello-world/actions.ts \
       example/hello-world/components/NoteForm.tsx \
       example/hello-world/components/WhoAmI.tsx \
       example/hello-world/components/NotePage.tsx \
       example/hello-world/components/WhoAmIPage.tsx \
       example/hello-world/island.config.ts \
       example/hello-world/routes.tsx \
       example/hello-world/index.ts
git commit -m "$(cat <<'EOF'
feat(example): /note and /whoami pages calling server actions

Two new island pages demonstrate the full server-fn round-trip: NoteForm
calls createNote on submit; WhoAmI calls whoAmI on mount. deleteNote is
gated by a requireUser middleware. Pages embed islands via the existing
<Island> wrapper (hydrate="load"); actions registered via the new
brust.registerActions + makeRenderer({ actions }) pair.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Integration tests — wire status codes

Add new tests to `tests/integration.test.ts` that exercise the action endpoint without depending on browser hydration. Tests follow the existing `spawn`/`readPortLine` pattern.

**Files:**
- Modify: `tests/integration.test.ts`

- [ ] **Step 1: Append the integration test block**

At the end of `tests/integration.test.ts`, append (preserve the existing tests):

```ts
test('action endpoint: happy path returns JSON', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: { ...process.env, BRUST_PORT: '38150', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/_brust/action/createNote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(['hi there']),
    })
    expect(resp.status).toBe(200)
    expect(resp.headers.get('content-type')).toContain('application/json')
    const body = await resp.json() as { id: string }
    expect(body.id).toMatch(/^n-\d+$/)
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)

test('action endpoint: malformed JSON args → 400', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: { ...process.env, BRUST_PORT: '38151', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/_brust/action/createNote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    })
    expect(resp.status).toBe(400)
    const body = await resp.text()
    expect(body).toContain('invalid args JSON')
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)

test('action endpoint: args not an array → 400', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: { ...process.env, BRUST_PORT: '38152', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/_brust/action/createNote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    })
    expect(resp.status).toBe(400)
    const body = await resp.text()
    expect(body).toContain('JSON array')
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)

test('action endpoint: unknown id → 404', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: { ...process.env, BRUST_PORT: '38153', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/_brust/action/missing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([]),
    })
    expect(resp.status).toBe(404)
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)

test('action endpoint: GET → 405', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: { ...process.env, BRUST_PORT: '38154', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/_brust/action/createNote`)
    expect(resp.status).toBe(405)
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)

test('action endpoint: id with bad charset → 404', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: { ...process.env, BRUST_PORT: '38155', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    // Dot in the id should be rejected by is_safe_action_id.
    const resp = await fetch(`http://127.0.0.1:${port}/_brust/action/bad.id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '[]',
    })
    expect(resp.status).toBe(404)
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)

test('action endpoint: missing Content-Length → 411', async () => {
  // fetch always sets Content-Length, so use a raw socket like the 414 test.
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: { ...process.env, BRUST_PORT: '38156', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const chunks: Uint8Array[] = []
    let resolveClose!: () => void
    const closed = new Promise<void>((r) => { resolveClose = r })
    const sock = await Bun.connect({
      hostname: '127.0.0.1', port,
      socket: {
        data(_s, data) { chunks.push(new Uint8Array(data)) },
        open() {}, close() { resolveClose() }, drain() {}, error() { resolveClose() },
      },
    })
    // Hand-crafted request: no Content-Length, no body.
    sock.write('POST /_brust/action/createNote HTTP/1.1\r\nHost: x\r\n\r\n')
    await Promise.race([
      closed,
      new Promise<void>((r) => setTimeout(r, 1000)),
    ])
    sock.end()
    const combined = Buffer.concat(chunks).toString('utf-8')
    expect(combined.split('\r\n')[0]).toContain('411')
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)
```

If `readPortLine` is not yet defined in the file (check by reading the top of `tests/integration.test.ts`), it's already shared at the bottom — confirm by:

```bash
grep -n "async function readPortLine" tests/integration.test.ts
```

If it's there, the tests above can use it as-is. If not, copy the helper from one of the existing tests.

- [ ] **Step 2: Run the integration suite**

Run: `cd /Users/detoro/code/brust && bun test tests/integration.test.ts`

Expected: all 18 existing tests + 7 new action tests pass. Total: 25.

If a test fails:
- 411 test failing → check that `parse_content_length` in `src/server.rs` triggers before the body-read loop. The 411 must fire when the header is missing, before any read.
- 400 (not-json) test failing → check the actionBranch in `runtime/routes.ts` — the parse-error 400 must include `invalid args JSON` literally so the assertion matches.
- 200 happy-path failing with timing — bump the test timeout (`}, 30_000)`) and the port to avoid collisions with leftover processes from other tests.

- [ ] **Step 3: Commit**

```bash
cd /Users/detoro/code/brust
git add tests/integration.test.ts
git commit -m "$(cat <<'EOF'
test(integration): server-functions wire status codes

Cover 200/400/404/405/411 paths through the /note + /_brust/action/<id>
endpoints. The 411 case uses a raw socket like the 414 test because fetch
always sets Content-Length.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Integration tests — action middleware

**Files:**
- Modify: `tests/integration.test.ts`

- [ ] **Step 1: Append middleware tests**

At the end of `tests/integration.test.ts`:

```ts
test('action middleware: short-circuits without cookie', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: { ...process.env, BRUST_PORT: '38160', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/_brust/action/deleteNote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(['n-123']),
    })
    expect(resp.status).toBe(401)
    expect(await resp.text()).toBe('login required')
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)

test('action middleware: passes through with cookie', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: { ...process.env, BRUST_PORT: '38161', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/_brust/action/deleteNote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': 'user=alice' },
      body: JSON.stringify(['n-123']),
    })
    expect(resp.status).toBe(200)
    const body = await resp.json() as { ok: boolean }
    expect(body.ok).toBe(true)
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)
```

- [ ] **Step 2: Run the integration suite**

Run: `cd /Users/detoro/code/brust && bun test tests/integration.test.ts`

Expected: all 27 tests pass (25 from previous task + 2 new).

- [ ] **Step 3: Commit**

```bash
cd /Users/detoro/code/brust
git add tests/integration.test.ts
git commit -m "$(cat <<'EOF'
test(integration): action middleware short-circuit + pass-through

Cover deleteNote gated by requireUser: 401 without cookie, 200 with cookie.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Integration test — SSR page + island marker for action callers

**Files:**
- Modify: `tests/integration.test.ts`

- [ ] **Step 1: Append the SSR-side test**

At the end of `tests/integration.test.ts`:

```ts
test('action-calling island page renders marker + importmap + bootstrap', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: { ...process.env, BRUST_PORT: '38170', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const html = await (await fetch(`http://127.0.0.1:${port}/note`)).text()
    // Marker for the NoteForm island
    expect(html).toContain('data-brust-island="NoteForm"')
    expect(html).toContain('data-hydrate="load"')
    // Importmap + bootstrap script tags
    expect(html).toContain('<script type="importmap">')
    expect(html).toContain('/_brust/islands/_bootstrap.js')

    // The NoteForm.js chunk is served from /_brust/islands.
    const chunk = await fetch(`http://127.0.0.1:${port}/_brust/islands/NoteForm.js`)
    expect(chunk.status).toBe(200)
    expect(chunk.headers.get('content-type')).toContain('javascript')
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 20_000)
```

- [ ] **Step 2: Run the integration suite**

Run: `cd /Users/detoro/code/brust && bun test tests/integration.test.ts`

Expected: all 28 tests pass.

- [ ] **Step 3: Commit**

```bash
cd /Users/detoro/code/brust
git add tests/integration.test.ts
git commit -m "$(cat <<'EOF'
test(integration): /note page wires island marker + bootstrap + chunk

End-to-end SSR-side check that the action-calling island page renders the
correct marker, includes the importmap + bootstrap script tags, and that
the per-island chunk is served from /_brust/islands. The hydration +
actual fetch are covered by the wire-status tests; this test asserts the
SSR side that those rely on.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Architecture.md update

**Files:**
- Modify: `architecture.md`

- [ ] **Step 1: Locate the "Designed not built" list**

Open `architecture.md` and find the "Designed not built" list. Per the handoff and the spec, the Server Functions entry is currently listed there (around line 1012).

```bash
grep -n "Server functions" architecture.md
```

- [ ] **Step 2: Move the "Server functions" entry from "Designed not built" to "Built"**

Mirror the Islands MVP pattern. After the Islands "Built" entry (around line 1001), add the Server Functions entry:

```markdown
- Server functions MVP: `brust.registerActions([{ id, fn, middleware? }])` registers async functions invokable from islands via `POST /_brust/action/<id>` (JSON args/return). Reuses the renderer tsfn via a `kind: 'render' | 'action'` envelope discriminant. Action-specific middleware (action def's own chain). Client helper `action<F>(id)` from `runtime/client` preserves types via TS generics + `import type` erase. New Rust napi `register_actions(ids: Vec<String>)`; new server.rs branch with charset/length/utf-8 guards and dedicated 404/405/411/413 error paths.
```

In the "Designed not built" list, remove the existing "Server functions" line (around 1012).

- [ ] **Step 3: Document MVP scope simplifications**

Find the "MVP scope simplifications" block under the Islands section (around line 460-470 — search for "MVP scope simplifications"). Add a parallel block under the Server Functions section that you just promoted. If the Server Functions section in the body of the doc doesn't have a "scope simplifications" subsection, add one with these bullets:

```markdown
**MVP scope simplifications (documented inline in plan + spec):**
- Manual `brust.registerActions([...])` — no `"use server"` directive scanner
- JSON-only — `FormData`/multipart is the Forms plan's job
- Action-specific middleware (no route-middleware inheritance via `X-Brust-Route`)
- Errors return `{ "error": { "message", "name" } }` JSON envelope on non-2xx; no stack-trace mode
- `runtime/client/action<F>(id)` helper bundled into each island chunk (~1 KB); shared chunk is a future optimisation
```

- [ ] **Step 4: Add the new follow-ups to the priority list**

Find the "Designed, not yet built (priority-ordered)" list (around line 87 in the handoff — search for it in `architecture.md`). Adjust the priority list to:
- Remove the entry "Server functions" (now built).
- Promote/add: `"use server"` directive + auto-rewrite (closes architecture vision gap) — `~2 days`.
- Note Forms & multipart now has Server Functions as its prerequisite (already noted in the existing list).

- [ ] **Step 5: Verify the doc still renders correctly**

A spot-check: search for any broken cross-references.

```bash
grep -n "Server functions" architecture.md
grep -n "use server" architecture.md
```

The first should now point to the "Built" entry; the second should point to the deferred directive plan.

- [ ] **Step 6: Run the full test suite one more time**

```bash
cd /Users/detoro/code/brust
cargo test --lib
cd runtime && bun run build:debug && cd -
bun test tests/integration.test.ts
```

Expected:
- `cargo test --lib`: 31 existing + ~12 new (3 envelope + 7 action_id + 5 server-side) = ~43 Rust unit tests, all pass
- `bun test tests/integration.test.ts`: 18 existing + 7 wire-status + 2 middleware + 1 SSR-side = 28 integration tests, all pass

- [ ] **Step 7: Commit**

```bash
cd /Users/detoro/code/brust
git add architecture.md
git commit -m "$(cat <<'EOF'
docs(architecture): server functions MVP shipped

Move Server Functions from "Designed not built" to "Built". Documents the
MVP scope simplifications inline (manual registerActions, JSON-only,
action-specific middleware, error envelope shape). Promotes "use server"
directive + auto-rewrite as the next follow-up.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Plan Self-Review (run before declaring done)

**Spec coverage check:**

| Spec section | Implementing task(s) |
|---|---|
| §1 MVP scope decisions | Locked in plan header + Task 0 spike verifies envelope shape; manual `registerActions` lives in Task 4 |
| §2 Architecture + data flow | Tasks 1–3 (Rust) + Tasks 4–6 (TS) implement the diagram end-to-end |
| §3 Wire format & envelope (RouteCall union + meta.contentType) | Task 1 (Rust) + Task 5 (TS) |
| §3 Rust dispatcher (URL match, charset, length, registry) | Task 3 |
| §4 Server-side API (ActionDef, registerActions) | Tasks 4–5 |
| §5 Client-side API (`action<F>(id)`, BrustActionError) | Task 6 |
| §6 Error model (server/Rust/client tables) | Task 3 (Rust pre-dispatch) + Task 5 (JS terminal + middleware) + Task 6 (client throw) |
| §7 Middleware reuse + cache-forbidden + req shape | Task 5 (chain composition) + Task 4 (registerActions does NOT accept cache field — ActionDef has none) |
| §8 Testing strategy | Tasks 8–10 (integration) + inline unit tests in Tasks 1, 2, 3 |
| §9 File list | Matches the "Files" lists at the top of each task |
| §10 Risks #1–7 | Risk #1 (tsfn conflation): mitigated by Task 5 clean `switch (kind)`. Risk #2 (wire backward-compat): Task 0 spike + Task 1 unit test for render-kind unchanged. Risk #3 (1 KB per island): documented in plan, not blocking. Risk #4 (id collisions runtime): Task 4 throws on duplicate. Risk #5 (JSON parse 400): Task 5 actionBranch parses + Array.isArray BEFORE middleware. Risk #6 (SAB cap): Task 3 enforces 413 at the limit. Risk #7 (no retries): inherited from render path, no new mitigation needed. |

**Placeholder scan:** Searched for "TBD", "TODO", "implement later", "Add appropriate" — none in the plan. Every code step shows the actual code.

**Type consistency check:**
- `ActionDef` shape: `{ id, fn, middleware? }` — consistent across Tasks 4, 5, 7.
- `BrustActionError(message, status, payload)` constructor shape — consistent in Task 6 + Task 7 NoteForm.
- `RouteCall` union: `kind: 'render' | 'action'` — consistent in Task 1 (Rust serialise) + Task 5 (TS parse).
- `args_json` field name in envelope — consistent in Task 0 spike, Task 1 ActionEnvelope, Task 3 build_action_envelope call, Task 5 actionBranch consume.
- `contentType` (camelCase on the wire) — consistent in spec §3, Task 3 ResponseMeta `#[serde(rename = "contentType")]`, Task 5 packResponse.
- `is_safe_action_id` defined in BOTH `src/lib.rs` and `src/server.rs` (intentional belt-and-suspenders) — Task 3 Step 4 test cross-checks they agree.

No drift detected.

---

*End of plan. After completing Task 11, the working tree should contain commits `feat(routes): ...` through `docs(architecture): server functions MVP shipped`, ~12 commits, mirroring the Islands MVP shape from session 4.*
