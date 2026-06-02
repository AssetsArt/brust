# Forms & Multipart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `POST /_brust/action/<id>` to accept `multipart/form-data` and `application/x-www-form-urlencoded` request bodies in addition to JSON, passing a `FormData` instance to handlers declared with the signature `(req, fd: FormData)`.

**Architecture:** Wire format refactor — `ActionEnvelope.args_json` is replaced by `content_type` + mutually-exclusive `body_text` / `body_b64`. Rust dispatches on Content-Type (UTF-8-validated text or base64-encoded binary). JS worker decodes per content-type and constructs FormData via `new Request(...).formData()` for multipart or `URLSearchParams` for form-urlencoded. New `formAction<F>(id)` client helper mirrors `action<F>(id)`.

**Tech Stack:** Rust 2024 edition, `base64 = "0.22"` (new dep), TypeScript, Bun 1.4-canary, `bun:test`, no new TS deps.

**Spec:** `docs/superpowers/specs/2026-05-24-forms-multipart-design.md`

---

## File map

| File | Action | Responsibility |
|---|---|---|
| `Cargo.toml` | Modify | Add `base64 = "0.22"` dep |
| `src/http.rs` | Modify | Add `error_415()` helper + status_text branch |
| `src/server.rs` | Modify | Add `parse_content_type` helper; rewrite action-branch body handling to dispatch on Content-Type; populate body_text / body_b64 |
| `src/routes.rs` | Modify | Refactor `ActionEnvelope` struct + `build_action_envelope` signature; update + extend unit tests |
| `runtime/routes.ts` | Modify | Update `RouteCall` action variant; rewrite `actionBranch` body-decoding to branch on `content_type` |
| `runtime/client/index.ts` | Modify | Add `formAction<F>(id)` helper next to existing `action<F>(id)` |
| `example/hello-world/actions.ts` | Modify | Add `uploadAvatar(req, fd: FormData)` action |
| `example/hello-world/components/AvatarUpload.tsx` | Create | Island component using `formAction` |
| `example/hello-world/components/AvatarPage.tsx` | Create | SSR page wrapping the island |
| `example/hello-world/routes.tsx` | Modify | Add `/avatar` route |
| `example/hello-world/island.config.ts` | Modify | Register `AvatarUpload` |
| `tests/integration.test.ts` | Modify | Add 6 new form-path integration tests |
| `architecture.md` | Modify | Promote Forms from "Designed not built" to "Built" |

---

## Task 1: Rust foundation — base64 dep + error_415 + parse_content_type

**Files:**
- Modify: `Cargo.toml`
- Modify: `src/http.rs`
- Modify: `src/server.rs`

- [ ] **Step 1: Write the failing tests**

Append to `src/http.rs` (inside `#[cfg(test)] mod tests`):

```rust
    #[test]
    fn error_415_status_line() {
        let resp = error_415();
        let s = std::str::from_utf8(resp).unwrap();
        assert!(s.starts_with("HTTP/1.1 415 Unsupported Media Type\r\n"));
        assert!(s.contains("Content-Length: 0"));
        // 415 closes the connection because the body may not have been fully read.
        assert!(s.contains("Connection: close"));
    }
```

Append to `src/server.rs` (inside `#[cfg(test)] mod tests`):

```rust
    #[test]
    fn parse_content_type_finds_header() {
        let raw = b"POST /x HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n\r\n";
        assert_eq!(parse_content_type(raw), Some("application/json".to_string()));
    }

    #[test]
    fn parse_content_type_case_insensitive_name() {
        let raw = b"POST /x HTTP/1.1\r\nHost: x\r\ncontent-type: text/plain\r\n\r\n";
        assert_eq!(parse_content_type(raw), Some("text/plain".to_string()));
    }

    #[test]
    fn parse_content_type_preserves_parameters() {
        let raw = b"POST /x HTTP/1.1\r\nHost: x\r\nContent-Type: multipart/form-data; boundary=abc123\r\n\r\n";
        assert_eq!(
            parse_content_type(raw),
            Some("multipart/form-data; boundary=abc123".to_string()),
        );
    }

    #[test]
    fn parse_content_type_trims_whitespace() {
        let raw = b"POST /x HTTP/1.1\r\nHost: x\r\nContent-Type:   application/json  \r\n\r\n";
        assert_eq!(parse_content_type(raw), Some("application/json".to_string()));
    }

    #[test]
    fn parse_content_type_missing_returns_none() {
        let raw = b"POST /x HTTP/1.1\r\nHost: x\r\n\r\n";
        assert_eq!(parse_content_type(raw), None);
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --lib parse_content_type 2>&1 | tail -10`

Expected: FAIL — `parse_content_type` not defined.

Run: `cargo test --lib error_415 2>&1 | tail -10`

Expected: FAIL — `error_415` not defined.

- [ ] **Step 3: Add `base64` dependency to `Cargo.toml`**

Open `Cargo.toml`. Under the existing `[dependencies]` section, add:

```toml
base64 = "0.22"
```

Run `cargo build 2>&1 | tail -5` to confirm dependency resolves cleanly (downloads + links).

- [ ] **Step 4: Implement `error_415` in `src/http.rs`**

Find the existing `error_413()` (or any nearby `error_*` helper). Append:

```rust
pub fn error_415() -> &'static [u8] {
    static B: &[u8] = b"HTTP/1.1 415 Unsupported Media Type\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
    B
}
```

If there is a `status_text` function that maps status codes to reason phrases, also add the `415` arm. (Grep for `match status` in `src/http.rs`.)

- [ ] **Step 5: Implement `parse_content_type` in `src/server.rs`**

Find `parse_content_length` (a similar helper from session 5). Append immediately after it:

```rust
/// Extract `Content-Type` from a buffered HTTP request's headers. Returns
/// None if the header is missing. Whitespace-trimmed. Preserves the
/// parameter part (e.g. `; boundary=...`) since the JS side needs it
/// to parse multipart bodies. Caller has already ensured `\r\n\r\n` is
/// present in `buf`.
fn parse_content_type(buf: &[u8]) -> Option<String> {
    let mut headers = [httparse::EMPTY_HEADER; 64];
    let mut req = httparse::Request::new(&mut headers);
    let _ = req.parse(buf);
    for h in req.headers.iter() {
        if h.name.eq_ignore_ascii_case("content-type") {
            return std::str::from_utf8(h.value).ok().map(|s| s.trim().to_string());
        }
    }
    None
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run:
```bash
cargo build 2>&1 | tail -5
cargo test --lib parse_content_type 2>&1 | tail -10
cargo test --lib error_415 2>&1 | tail -10
cargo test --lib 2>&1 | tail -5
```

Expected: build clean (pre-existing dead_code warning only); 5 + 1 new tests pass; total `52 pass / 0 fail` (47 prior + 5 + 1 new).

- [ ] **Step 7: Commit**

```bash
git add Cargo.toml Cargo.lock src/http.rs src/server.rs
git commit -m "feat(rust): base64 dep + error_415 + parse_content_type

Foundation for Forms & Multipart sub-project:
- Adds base64 0.22 to Cargo.toml (used by Task 2 to encode multipart
  bodies for the action envelope).
- error_415() emits HTTP/1.1 415 Unsupported Media Type with
  Connection: close (body may be partially read so keep-alive is unsafe).
- parse_content_type() mirrors parse_content_length: case-insensitive
  header name, whitespace-trimmed value, parameters preserved (the
  multipart boundary parameter must survive the round trip to JS).

Tests: 6 new Rust unit tests (5 for parse_content_type + 1 for
error_415). 52 unit tests total now.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Wire format refactor — `ActionEnvelope` + server.rs dispatch + JS decoder

**This is the load-bearing task — single atomic commit because Rust + JS must agree on the envelope shape simultaneously. Two-stage review (spec compliance, then code quality) per session 5 convention.**

**Files:**
- Modify: `src/routes.rs` (ActionEnvelope struct, build_action_envelope signature, tests)
- Modify: `src/server.rs` (action branch: content-type dispatch, body_text / body_b64 population)
- Modify: `runtime/routes.ts` (RouteCall action variant, actionBranch body-decoding)

- [ ] **Step 1: Update Rust envelope shape**

In `src/routes.rs`, change the `ActionEnvelope` struct:

```rust
/// Mirrors RouteEnvelope but carries a string action_id (not numeric route_id)
/// and a content-type-aware body. `kind: "action"` discriminates from the
/// render variant. Exactly ONE of body_text / body_b64 is Some, decided by
/// the request's Content-Type header (see src/server.rs).
#[derive(Serialize)]
pub struct ActionEnvelope<'a> {
    pub kind: &'static str,
    pub action_id: &'a str,
    /// Request's Content-Type header, lowercased + trimmed. Empty string
    /// means the header was missing. JS dispatcher branches on this.
    pub content_type: &'a str,
    /// UTF-8-validated text body. Present for application/json and
    /// application/x-www-form-urlencoded. Absent for multipart.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body_text: Option<&'a str>,
    /// Base64-encoded binary body. Present for multipart/form-data.
    /// JS decodes via Buffer.from(s, 'base64') before parsing.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body_b64: Option<&'a str>,
    pub req: RequestEnvelope,
}
```

And rewrite `build_action_envelope` to match:

```rust
pub fn build_action_envelope(
    method: &str,
    full_path: &str,
    action_id: &str,
    content_type: &str,
    body_text: Option<&str>,
    body_b64: Option<&str>,
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
        content_type,
        body_text,
        body_b64,
        req,
    };
    serde_json::to_string(&env).unwrap()
}
```

- [ ] **Step 2: Update + extend Rust envelope tests**

In `src/routes.rs`, replace the existing `action_envelope_serializes_with_kind_action` and `action_envelope_args_json_preserves_quotes` tests with three new tests covering each branch:

```rust
    #[test]
    fn action_envelope_json_path() {
        let json = build_action_envelope(
            "POST",
            "/_brust/action/createNote",
            "createNote",
            "application/json",
            Some(r#"["hello"]"#),
            None,
            b"POST /_brust/action/createNote HTTP/1.1\r\nHost: x\r\n\r\n",
        );
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["kind"], "action");
        assert_eq!(parsed["action_id"], "createNote");
        assert_eq!(parsed["content_type"], "application/json");
        assert_eq!(parsed["body_text"], r#"["hello"]"#);
        // body_b64 must be absent on the JSON path (skip_serializing_if).
        assert!(parsed.get("body_b64").is_none());
        assert_eq!(parsed["req"]["method"], "POST");
    }

    #[test]
    fn action_envelope_form_urlencoded_path() {
        let json = build_action_envelope(
            "POST",
            "/_brust/action/registerUser",
            "registerUser",
            "application/x-www-form-urlencoded",
            Some("name=Alice&age=30"),
            None,
            b"POST /_brust/action/registerUser HTTP/1.1\r\nHost: x\r\n\r\n",
        );
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["content_type"], "application/x-www-form-urlencoded");
        assert_eq!(parsed["body_text"], "name=Alice&age=30");
        assert!(parsed.get("body_b64").is_none());
    }

    #[test]
    fn action_envelope_multipart_path() {
        let json = build_action_envelope(
            "POST",
            "/_brust/action/uploadAvatar",
            "uploadAvatar",
            "multipart/form-data; boundary=abc",
            None,
            Some("LS1hYmMNCkNvbnRlbnQt"),
            b"POST /_brust/action/uploadAvatar HTTP/1.1\r\nHost: x\r\n\r\n",
        );
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["content_type"], "multipart/form-data; boundary=abc");
        assert_eq!(parsed["body_b64"], "LS1hYmMNCkNvbnRlbnQt");
        assert!(parsed.get("body_text").is_none());
    }

    #[test]
    fn action_envelope_args_json_quoting_preserved() {
        // Same shape as the old args_json_preserves_quotes test — pinned because
        // the actionBranch in JS does JSON.parse(body_text) and any quote loss
        // between Rust → napi → JS would surface as a parse error in production.
        let json = build_action_envelope(
            "POST",
            "/_brust/action/x",
            "x",
            "application/json",
            Some(r#"["hi \"there\"", 42]"#),
            None,
            b"",
        );
        let outer: serde_json::Value = serde_json::from_str(&json).unwrap();
        let inner: serde_json::Value = serde_json::from_str(outer["body_text"].as_str().unwrap()).unwrap();
        assert_eq!(inner[0], r#"hi "there""#);
        assert_eq!(inner[1], 42);
    }
```

- [ ] **Step 3: Update `src/server.rs` action branch**

Find the action branch around line 299. Replace this block:

```rust
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
```

…with:

```rust
            let body_slice = &buf[header_end..header_end + content_length];

            // Detect Content-Type and route to the right body-encoding path.
            // ct_lower is ASCII-lowercased so 'application/JSON; charset=UTF-8'
            // (legal per RFC 7231) is accepted on the JSON branch.
            let content_type = parse_content_type(&buf[..header_end]).unwrap_or_default();
            let ct_lower = content_type.to_ascii_lowercase();

            let body_text_string: Option<String>;
            let body_b64_string: Option<String>;

            if ct_lower.is_empty()
                || ct_lower.starts_with("application/json")
                || ct_lower.starts_with("application/x-www-form-urlencoded")
            {
                // Text body — UTF-8 validated.
                match std::str::from_utf8(body_slice) {
                    Ok(s) => {
                        body_text_string = Some(s.to_string());
                        body_b64_string = None;
                    }
                    Err(_) => {
                        let _ = s.write_all(http::error_400()).await;
                        continue;
                    }
                }
            } else if ct_lower.starts_with("multipart/form-data") {
                // Binary body. base64-encode for transport through the JSON envelope.
                use base64::Engine as _;
                let b64 = base64::engine::general_purpose::STANDARD.encode(body_slice);
                body_text_string = None;
                body_b64_string = Some(b64);
            } else {
                // Unsupported Content-Type — close the connection because the
                // body may have been partially read.
                let _ = s.write_all(http::error_415()).await;
                return;
            }

            let envelope_json = crate::routes::build_action_envelope(
                &method,
                &path,
                id,
                &content_type,
                body_text_string.as_deref(),
                body_b64_string.as_deref(),
                &buf[..header_end],
            );
```

- [ ] **Step 4: Update `runtime/routes.ts` RouteCall type**

Find the action variant in `RouteCall` (around line 106-113). Replace:

```ts
  | {
      kind: 'action'
      action_id: string
      /** Raw JSON args body (a JSON string). Worker parses it once,
       * checks Array.isArray, then spreads into the action handler. */
      args_json: string
      req: BrustRequest
    }
```

…with:

```ts
  | {
      kind: 'action'
      action_id: string
      /** Request's Content-Type, lowercased + trimmed. '' means the header
       * was missing. JS dispatcher branches on this. */
      content_type: string
      /** UTF-8 text body — present for application/json and
       * application/x-www-form-urlencoded. Mutually exclusive with body_b64. */
      body_text?: string
      /** Base64-encoded binary body — present for multipart/form-data.
       * JS decodes via Buffer.from(s, 'base64') before parsing. */
      body_b64?: string
      req: BrustRequest
    }
```

- [ ] **Step 5: Update `actionBranch` to decode by content-type**

Find `actionBranch` in `runtime/routes.ts` (around line 220). Replace the body-decoding block (currently the `try { const decoded = JSON.parse(call.args_json) ... }` block, around lines 241-260) with:

```ts
  // Decode the body into the args array that will be spread into the handler.
  // Three paths: JSON (existing), form-urlencoded (new), multipart (new).
  // JSON-shape errors surface as 400 envelopes through packResponse.
  let argsForFn: unknown[]
  try {
    if (call.body_b64 !== undefined) {
      // Multipart path — base64 → bytes → Web Request.formData()
      const bytes = Buffer.from(call.body_b64, 'base64')
      const synthReq = new Request('http://x', {
        method: 'POST',
        headers: { 'Content-Type': call.content_type },
        body: bytes,
      })
      const fd = await synthReq.formData()
      argsForFn = [fd]
    } else if (call.content_type.toLowerCase().startsWith('application/x-www-form-urlencoded')) {
      // Form-urlencoded path — URLSearchParams → FormData
      const params = new URLSearchParams(call.body_text ?? '')
      const fd = new FormData()
      for (const [k, v] of params) fd.append(k, v)
      argsForFn = [fd]
    } else {
      // JSON path (default — empty or application/json content type).
      const decoded = JSON.parse(call.body_text ?? '') as unknown
      if (!Array.isArray(decoded)) {
        return packResponse(view, encoder, {
          status: 400,
          body: '{"error":{"message":"args must be a JSON array"}}',
          contentType: 'application/json; charset=utf-8',
        })
      }
      argsForFn = decoded
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return packResponse(view, encoder, {
      status: 400,
      body: JSON.stringify({ error: { message: `invalid request body: ${msg}` } }),
      contentType: 'application/json; charset=utf-8',
    })
  }
```

Then find the line that uses `args` further down (the terminal handler):

```ts
      const result = await def.fn(call.req, ...args)
```

Update the variable name to `argsForFn` (or just rename `args` → `argsForFn` consistently throughout the function):

```ts
      const result = await def.fn(call.req, ...argsForFn)
```

- [ ] **Step 6: Build everything**

Run:
```bash
cargo build 2>&1 | tail -5
cd runtime && bun run build:debug && cd -
```

Expected: clean (pre-existing dead_code warning only).

- [ ] **Step 7: Run Rust tests**

Run: `cargo test --lib 2>&1 | tail -10`

Expected: `54 pass / 0 fail` (52 from Task 1 + 2 net new envelope tests; old 2 were replaced by 3 new + 1 carry-over = +2 net).

- [ ] **Step 8: Run integration tests (existing JSON path must still pass)**

Run: `bun test ./tests/integration.test.ts 2>&1 | tail -10`

Expected: `30 pass / 0 fail` — same count as before, since the JSON path still works after the refactor.

If any action test fails, the wire-format refactor broke the JSON path. Common culprits:
- Forgot to rename `call.args_json` to `call.body_text` somewhere in actionBranch
- The `call.content_type.toLowerCase()` call throws when `content_type` is undefined — should not happen because Rust always sets it, but guard with `??` if it does

- [ ] **Step 9: Commit**

```bash
git add src/routes.rs src/server.rs runtime/routes.ts
git commit -m "feat(action): content-type-aware wire format

ActionEnvelope.args_json is replaced by content_type +
mutually-exclusive body_text / body_b64. Rust dispatches on Content-Type:
- application/json or empty CT → UTF-8 text → body_text
- application/x-www-form-urlencoded → UTF-8 text → body_text
- multipart/form-data → base64-encoded binary → body_b64
- anything else → 415 Unsupported Media Type (Connection: close)

JS actionBranch decodes per path:
- body_b64 → Buffer.from(b64,'base64') → new Request().formData() → fd
- form-urlencoded body_text → URLSearchParams → FormData → fd
- JSON body_text → JSON.parse + Array.isArray validation (existing path)

Handlers expecting FormData receive args[0] = FormData instance.
Handlers expecting JSON-positional args see args = parsed array.

Tests: 4 envelope tests rewritten for the new shape (2 old replaced
by 3 new + 1 carry-over for quote-preservation). All 30 integration
tests still pass — JSON path is unaffected at user level.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Client — `formAction<F>(id)` helper

**Files:**
- Modify: `runtime/client/index.ts`

- [ ] **Step 1: Read the current state of `runtime/client/index.ts`**

Confirm the existing `action<F>(id)` helper + `BrustActionError` class are present. The new helper sits next to them.

- [ ] **Step 2: Add the helper**

Append to `runtime/client/index.ts` (after the existing `action` export):

```ts
type FormActionFn<F> =
  F extends (req: any, fd: FormData) => infer R
    ? (fd: FormData) => R
    : never

/** Build a typed RPC stub for a form-receiving action.
 *
 * The server handler MUST be declared with signature
 * `(req: BrustRequest, fd: FormData) => Promise<R>`. The framework parses
 * the request's multipart or form-urlencoded body server-side and passes
 * a FormData instance to the handler.
 *
 * Usage:
 *   import type * as srv from '../actions'
 *   const uploadAvatar = formAction<typeof srv.uploadAvatar>('uploadAvatar')
 *   const result = await uploadAvatar(new FormData(form))
 *
 * @param id  The action id — matches the named export from a `'use server'`
 *            file discovered by `brust.scanActions()`.
 */
export function formAction<F extends (req: any, fd: FormData) => unknown>(
  id: string,
): FormActionFn<F> {
  return (async (fd: FormData) => {
    if (!(fd instanceof FormData)) {
      throw new TypeError('formAction expects a FormData argument')
    }
    // DO NOT set Content-Type manually. fetch() auto-sets
    // 'multipart/form-data; boundary=<random>' when body is a FormData;
    // overriding loses the boundary and the server can't parse the body.
    const res = await fetch(`/_brust/action/${encodeURIComponent(id)}`, {
      method: 'POST',
      body: fd,
    })
    const text = await res.text()
    if (!res.ok) {
      try {
        const err = JSON.parse(text) as { error?: { message?: string, name?: string } }
        throw new BrustActionError(
          err.error?.message ?? text,
          res.status,
          err.error?.name,
        )
      } catch (e) {
        if (e instanceof BrustActionError) throw e
        throw new BrustActionError(text || res.statusText, res.status)
      }
    }
    return text ? JSON.parse(text) : undefined
  }) as FormActionFn<F>
}
```

(If the existing `BrustActionError` takes a different constructor signature than `(message, status, name?)`, adapt the call to match — read its current shape before writing.)

- [ ] **Step 3: Type-check**

Run: `cd runtime && bunx tsc --noEmit 2>&1 | grep -E "client/index" | head -10`

Expected: no errors specific to `runtime/client/index.ts`. (Pre-existing errors elsewhere are ignored.)

- [ ] **Step 4: Commit**

```bash
git add runtime/client/index.ts
git commit -m "feat(client): formAction<F>(id) helper for multipart server actions

Symmetric to action<F>(id) from server-functions MVP. Takes a FormData
and posts it to /_brust/action/<id> via fetch — fetch auto-sets
multipart/form-data with a fresh boundary. Type generic preserves the
handler's TypeScript signature so client call sites stay type-safe.

Zero imports (browser globals only) — matches the existing action()
helper to keep island chunks small.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Example app — `uploadAvatar` action + AvatarUpload island + `/avatar` route

**Files:**
- Modify: `example/hello-world/actions.ts`
- Create: `example/hello-world/components/AvatarUpload.tsx`
- Create: `example/hello-world/components/AvatarPage.tsx`
- Modify: `example/hello-world/routes.tsx`
- Modify: `example/hello-world/island.config.ts`

- [ ] **Step 1: Add the `uploadAvatar` action**

Open `example/hello-world/actions.ts`. After `pingAction` (the last existing export), append:

```ts

/** Demo form action: receives a multipart FormData containing a `file` field.
 * Returns the file's name + size — no actual storage in the demo. */
export async function uploadAvatar(_req: BrustRequest, fd: FormData): Promise<{ name: string, size: number }> {
  const file = fd.get('file')
  if (!(file instanceof File)) throw new Error('file field required (multipart File)')
  if (file.size > 200 * 1024) throw new Error('file too big (max 200 KB)')
  return { name: file.name, size: file.size }
}
```

- [ ] **Step 2: Create the AvatarUpload island**

Create `example/hello-world/components/AvatarUpload.tsx`:

```tsx
import { useState } from 'react'
import { formAction } from '../../../runtime/client/index.ts'
import type * as srv from '../actions'

const uploadAvatar = formAction<typeof srv.uploadAvatar>('uploadAvatar')

export function AvatarUpload() {
  const [status, setStatus] = useState<string>('Choose a file and click Upload.')

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    setStatus('Uploading...')
    try {
      const result = await uploadAvatar(fd)
      setStatus(`Uploaded ${result.name} (${result.size} bytes).`)
    } catch (err) {
      setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return (
    <form onSubmit={onSubmit} encType="multipart/form-data">
      <input type="file" name="file" accept="image/*" />
      <button type="submit">Upload</button>
      <p>{status}</p>
    </form>
  )
}
```

- [ ] **Step 3: Create the AvatarPage SSR wrapper**

Create `example/hello-world/components/AvatarPage.tsx`:

```tsx
import { Island } from '../../../runtime/index.ts'
import { AvatarUpload } from './AvatarUpload'

export function AvatarPage() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>Avatar Upload — Brust demo</title>
      </head>
      <body>
        <h1>Avatar Upload</h1>
        <p>Demonstrates `formAction` posting multipart/form-data to a server action.</p>
        <Island component={AvatarUpload} props={{}} />
      </body>
    </html>
  )
}
```

- [ ] **Step 4: Register the `/avatar` route**

Open `example/hello-world/routes.tsx`. Find the existing `defineRoutes([ ... ])` call. Add an entry for `/avatar`:

```tsx
import { AvatarPage } from './components/AvatarPage'
// ...inside the routes array:
  { path: '/avatar', component: AvatarPage },
```

(Place it alongside the existing `/note` and `/whoami` entries.)

- [ ] **Step 5: Register the island in `island.config.ts`**

Open `example/hello-world/island.config.ts`. Find the existing `islands` array and add:

```ts
import { AvatarUpload } from './components/AvatarUpload'
// inside the islands export:
  { id: 'AvatarUpload', component: AvatarUpload },
```

(Match the format of existing entries like `NoteForm`, `WhoAmI`.)

- [ ] **Step 6: Manually smoke-test the page**

Build and launch:

```bash
cd runtime && bun run build:debug && cd -
BRUST_PORT=38910 bun run example/hello-world/index.ts > /tmp/brust-avatar.log 2>&1 &
sleep 8
```

Check boot log — `scanActions found 5 action(s)` should now include `uploadAvatar`:

```bash
grep "scanActions found" /tmp/brust-avatar.log
```

Hit the `/avatar` page and confirm SSR works:

```bash
curl -s http://127.0.0.1:38910/avatar | head -20
```

Expected: HTML with the `<form>` markup + island marker.

Smoke-test the action via multipart curl:

```bash
echo "hello" > /tmp/tiny.txt
curl -s -X POST -F 'file=@/tmp/tiny.txt' http://127.0.0.1:38910/_brust/action/uploadAvatar
# expected: {"name":"tiny.txt","size":6}
```

Smoke-test the 415 path:

```bash
curl -si -X POST -H 'Content-Type: application/xml' --data '<x/>' \
  http://127.0.0.1:38910/_brust/action/uploadAvatar | head -1
# expected: HTTP/1.1 415 Unsupported Media Type
```

Kill the server:

```bash
kill %1 2>/dev/null
wait %1 2>/dev/null
rm /tmp/tiny.txt
```

If any smoke check fails, STOP and report.

- [ ] **Step 7: Commit**

```bash
git add example/hello-world/actions.ts \
        example/hello-world/components/AvatarUpload.tsx \
        example/hello-world/components/AvatarPage.tsx \
        example/hello-world/routes.tsx \
        example/hello-world/island.config.ts
git commit -m "feat(example): uploadAvatar action + AvatarUpload island + /avatar

Demonstrates the new Forms & Multipart support end-to-end:
- uploadAvatar(req, fd: FormData) action reads fd.get('file') as File,
  caps at 200 KB, returns name + size. Exercises the multipart path.
- AvatarUpload island uses formAction<typeof srv.uploadAvatar> to type
  the call. On submit, builds FormData from the form element and posts.
- /avatar route SSRs the page with the island marker; client bootstraps
  the AvatarUpload chunk on hydrate.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Integration tests — 6 new form-path tests

**Files:**
- Modify: `tests/integration.test.ts`

- [ ] **Step 1: Find a free port range**

The session 5 + session 6 conventions used 38150-38191 for action / island tests. Use 38186-38191 for the 6 new form tests.

(Verify by running: `grep -oE "BRUST_PORT: '[0-9]+'" tests/integration.test.ts | sort -u | tail -10` — confirm no collision.)

- [ ] **Step 2: Add the 6 tests at the end of the file**

Append to `tests/integration.test.ts`:

```ts
test('action endpoint: form-urlencoded body → FormData arg', async () => {
  // Server uploadAvatar expects a File via fd.get('file'); form-urlencoded
  // has no Files, so we verify the FormData path itself by posting
  // form-urlencoded to a JSON-shaped action (createNote): the JSON action
  // receives the FormData as args[0] which is NOT a string — it should
  // throw with a JSON 500. That confirms the framework went down the
  // form-urlencoded path even on a JSON-declared action.
  //
  // For a real form-urlencoded happy path, we need a dedicated action.
  // pingAction takes no args; if we post form-urlencoded body to pingAction,
  // the framework parses it into FormData, then spreads [FormData] into
  // pingAction (which ignores its args). Should return 200 with empty body.
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: { ...process.env, BRUST_PORT: '38186', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/_brust/action/pingAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'unused=field',
    })
    expect(resp.status).toBe(200)
    expect(await resp.text()).toBe('')
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)

test('action endpoint: multipart body → FormData with File', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: { ...process.env, BRUST_PORT: '38187', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const fd = new FormData()
    fd.append('file', new File(['hello'], 'greeting.txt', { type: 'text/plain' }))
    const resp = await fetch(`http://127.0.0.1:${port}/_brust/action/uploadAvatar`, {
      method: 'POST',
      body: fd,
    })
    expect(resp.status).toBe(200)
    const body = await resp.json() as { name: string, size: number }
    expect(body.name).toBe('greeting.txt')
    expect(body.size).toBe(5)
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)

test('action endpoint: unsupported Content-Type → 415', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: { ...process.env, BRUST_PORT: '38188', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/_brust/action/createNote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml' },
      body: '<x/>',
    })
    expect(resp.status).toBe(415)
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)

test('action endpoint: malformed multipart body → 400', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: { ...process.env, BRUST_PORT: '38189', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/_brust/action/uploadAvatar`, {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=does-not-match' },
      body: 'not-actually-multipart',
    })
    expect(resp.status).toBe(400)
    const text = await resp.text()
    expect(text).toContain('invalid request body')
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)

test('action endpoint: JSON path still works after wire-format refactor', async () => {
  // Sanity test — duplicates the createNote happy path from session 5 but
  // proves the body_text refactor preserved JSON semantics.
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: { ...process.env, BRUST_PORT: '38190', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/_brust/action/createNote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(['hello after refactor']),
    })
    expect(resp.status).toBe(200)
    const body = await resp.json() as { id: string }
    expect(body.id).toMatch(/^n-\d+$/)
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)

test('action endpoint: middleware short-circuits a multipart action', async () => {
  // deleteNote is JSON-shape with requireUser middleware. Posting multipart
  // to it without a cookie should still 401 — middleware runs before body
  // parsing reaches the handler.
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: { ...process.env, BRUST_PORT: '38191', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const fd = new FormData()
    fd.append('noteId', 'n-1')
    const resp = await fetch(`http://127.0.0.1:${port}/_brust/action/deleteNote`, {
      method: 'POST',
      body: fd,
    })
    expect(resp.status).toBe(401)
    expect(await resp.text()).toBe('login required')
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)
```

- [ ] **Step 3: Run the new tests**

```bash
bun test ./tests/integration.test.ts --test-name-pattern "form-urlencoded|multipart|Unsupported|malformed multipart|JSON path still|middleware short-circuits a multipart" 2>&1 | tail -10
```

Expected: `6 pass / 0 fail`.

- [ ] **Step 4: Run the full integration suite**

```bash
bun test ./tests/integration.test.ts 2>&1 | tail -5
```

Expected: `36 pass / 0 fail` (30 prior + 6 new).

If any prior test fails: the refactor regressed something. Read the failing test and either (a) fix the regression in Task 2 (most likely) or (b) update the test if its assertion was incompatible with the new envelope shape (less likely — tests check behaviour, not envelope shape).

- [ ] **Step 5: Commit**

```bash
git add tests/integration.test.ts
git commit -m "test(integration): 6 new form-path tests for action endpoint

- form-urlencoded body → FormData arg passes through to a void action
- multipart body with File → uploadAvatar returns name + size
- application/xml → 415 Unsupported Media Type
- multipart with mismatched boundary → 400 invalid request body
- JSON path unchanged after wire refactor (regression guard)
- requireUser middleware still short-circuits a multipart-posted action

Ports 38186-38191. 36 integration tests pass total.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Update `architecture.md`

**Files:**
- Modify: `architecture.md`

- [ ] **Step 1: Find the "Built vs Designed not built" lists**

```bash
grep -n "Forms\|multipart\|Designed not built\|Built" architecture.md | head -20
```

- [ ] **Step 2: Move Forms entry from "Designed not built" to "Built"**

Locate the bullet in "Designed not built" (it may currently read something like):

```
- **Forms & multipart** — unblocked by Server Functions. ~1 day.
```

Delete it.

Add to the "Built" list (place it near the `'use server'` directive entry, which is closely related):

```markdown
- **Forms & Multipart** — `POST /_brust/action/<id>` accepts `multipart/form-data` and `application/x-www-form-urlencoded` bodies in addition to JSON. Handlers declare `(req: BrustRequest, fd: FormData) => R` for form actions. Client helper `formAction<F>(id)` mirrors `action<F>(id)`. Wire-level: `ActionEnvelope.args_json` replaced by `content_type` + `body_text` / `body_b64`; multipart bodies are base64-encoded for transport through the JSON envelope. 256 KB body cap unchanged.
```

- [ ] **Step 3: Update the performance / acceptance section if needed**

The performance section near the bottom (perf table) doesn't need updating — Forms doesn't change render-path perf and the action path was already benched in session 5.

- [ ] **Step 4: Commit**

```bash
git add architecture.md
git commit -m "docs(architecture): Forms & Multipart shipped

Moves the entry from 'Designed not built' to 'Built'. Documents the
new content-type dispatch in the action endpoint and the formAction
client helper, plus the wire-format refactor (args_json removed in
favour of content_type + body_text/body_b64).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Spec coverage check (self-review)

Spec section → task that implements it:

| Spec S | Task |
|---|---|
| S1 Goal — multipart + form-urlencoded support | Tasks 2, 3, 4 |
| S1 Success criterion + concrete acceptance curls | Tasks 4 (smoke), 5 (automated) |
| S2.1 Rust `ActionEnvelope` shape | Task 2 |
| S2.2 TS `RouteCall` shape | Task 2 |
| S3.1 server.rs Content-Type dispatch | Task 2 |
| S3.2 `parse_content_type` | Task 1 |
| S3.3 `error_415` | Task 1 |
| S3.4 `build_action_envelope` signature change | Task 2 |
| S4 actionBranch JS decoding | Task 2 |
| S5 `formAction<F>(id)` | Task 3 |
| S6 Body cap (no change) | Verified implicitly — code keeps `MAX_ACTION_BODY_BYTES` |
| S7 Migration of existing JSON actions (zero user-facing change) | Verified by integration tests carrying over |
| S7.3 Example app additions | Task 4 |
| S8 Error handling matrix | Task 2 (Rust 415, JS 400 errors) + Task 5 (tests) |
| S9 Tests — Rust unit + integration | Task 1 (5 Rust), Task 2 (4 Rust), Task 5 (6 integration) |

All spec sections mapped. No requirements without a task.

**Type-consistency note:** `body_text` / `body_b64` field names match between Rust (`src/routes.rs`), TS (`runtime/routes.ts`), and the spec. `formAction` signature `(fd: FormData) => Promise<R>` matches the spec.
