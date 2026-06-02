# Forms & Multipart — Design Spec

**Sub-project:** Tier-2 follow-up. Extends server actions to accept HTML form bodies.
**Date:** 2026-05-24
**Status:** approved for implementation planning
**Parent design:** `architecture.md` S "Server functions"
**Related plans:** `2026-05-24-server-functions-design.md` (action wire format), `2026-05-24-use-server-directive-design.md` (action discovery — actions discovered via `'use server'` files can be either JSON or form handlers)

---

## 1. Overview & Scope

### Goal

Extend the existing `POST /_brust/action/<id>` endpoint to accept
form-shaped request bodies in addition to JSON. Specifically:

- `application/x-www-form-urlencoded` (text-only HTML forms)
- `multipart/form-data` (file uploads + text fields)

Server action handlers that expect form data declare it explicitly via
their signature: `async function uploadAvatar(req: BrustRequest, fd: FormData): Promise<R>`.
The framework parses the body and passes a `FormData` instance to the
handler. Existing JSON-receiving handlers stay on the JSON path
unchanged.

```tsx
// example/hello-world/actions.ts
'use server'
import type { BrustRequest } from 'brust'

export async function uploadAvatar(req: BrustRequest, fd: FormData): Promise<{ url: string }> {
  const file = fd.get('file')
  if (!(file instanceof File)) throw new Error('file required')
  if (file.size > 200 * 1024) throw new Error('file too big (max 200 KB)')
  // pretend to store...
  return { url: `https://example.test/avatars/${file.name}` }
}
```

```tsx
// example/hello-world/components/AvatarUpload.tsx (island)
import { formAction } from 'brust/client'
import type * as srv from '../actions'

const uploadAvatar = formAction<typeof srv.uploadAvatar>('uploadAvatar')

export function AvatarUpload() {
  async function onSubmit(e: SubmitEvent) {
    e.preventDefault()
    const fd = new FormData(e.currentTarget as HTMLFormElement)
    const { url } = await uploadAvatar(fd)
    console.log('uploaded:', url)
  }
  return <form onSubmit={onSubmit}>...</form>
}
```

### Success criterion

> Running the example app, an island mounted on `/avatar` calls
> `await uploadAvatar(new FormData(form))` over `POST /_brust/action/uploadAvatar`
> with `multipart/form-data; boundary=...`, the server parses the multipart
> body, the handler reads `fd.get('file')` as a `File`, and the response
> JSON `{"url":"..."}` round-trips correctly.

### Concrete acceptance

```bash
# multipart upload — small file
$ curl -s -X POST \
    -F 'name=Alice' \
    -F 'file=@/tmp/avatar.png' \
    http://127.0.0.1:38900/_brust/action/uploadAvatar
{"url":"https://example.test/avatars/avatar.png"}

# form-urlencoded — text field
$ curl -s -X POST \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    --data 'name=Alice&age=30' \
    http://127.0.0.1:38900/_brust/action/registerUser
{"ok":true}

# unsupported Content-Type
$ curl -si -X POST \
    -H 'Content-Type: application/xml' \
    --data '<x/>' \
    http://127.0.0.1:38900/_brust/action/createNote | head -1
HTTP/1.1 415 Unsupported Media Type

# existing JSON action still works
$ curl -s -X POST -H 'content-type: application/json' \
    --data '["hi"]' \
    http://127.0.0.1:38900/_brust/action/createNote
{"id":"n-1716527812345"}

$ bun test
✓ 30+ integration tests pass (existing + N new form tests)

$ cargo test --lib
✓ 47+ Rust unit tests pass (existing + N new envelope tests)
```

### MVP scope decisions (locked during brainstorm 2026-05-24)

| Decision | Choice | Rationale |
|---|---|---|
| Invocation model | **JS-driven only** | No native `<form action="/_brust/action/...">` redirect support; the island invokes `formAction<F>(id)(new FormData(form))`. Keeps response-shape uniform (JSON always). Native HTML form support deferred — needs Accept-header negotiation and HTML/303 responses. |
| Handler signature | **Single `FormData` arg** | `fn(req, fd: FormData)`. No magic positional unfolding of fields. Type-safe via the generic on `formAction<F>(id)`. |
| Body cap | **Stays 256 KB** | MAX_ACTION_BODY_BYTES unchanged. Multipart bodies fit in the SAB envelope path. Larger uploads (avatars > 200 KB) deferred — needs SAB resize or alternate body transport. |
| Wire format | **Refactor `ActionEnvelope`** | Replace `args_json: string` with `content_type: string` + ONE of `body_text?: string` OR `body_b64?: string`. JSON requests use `body_text`; multipart uses `body_b64`. |
| Multipart parsing | **JS-side, via `Request.formData()`** | Bun's Web API does the work. Rust just passes bytes. |
| Form-urlencoded parsing | **JS-side, via `URLSearchParams` → `FormData`** | Same FormData passed to handler regardless of underlying encoding. |
| Client API | **New `formAction<F>(id)` helper** | Symmetric to `action<F>(id)` from server-functions MVP. Generic preserves the handler's TypeScript signature. |

### Out of scope (deferred)

1. **Native HTML form support** (`<form action="...">` direct posting) — requires Accept-header negotiation, redirect-after-POST flow, CSRF tokens. Add in a follow-up.
2. **Streaming / chunked upload** — current 256 KB cap is fine for forms. Bumping the cap requires SAB resize protocol (separate sub-project).
3. **Per-field validation schemas** (zod-style) — handler does its own validation today. Schemas can be a follow-on once an Agentic surface needs them.
4. **Large file storage** (S3 / disk write) — out of scope; handler implements its own persistence.
5. **CSRF protection** — middleware-level concern, not a forms concern. Users layer their own middleware via `withMiddleware`.
6. **Progress events** — needs streaming + an SSE-or-similar back-channel.

---

## 2. Wire format changes

### 2.1 `ActionEnvelope` (Rust → JS worker, via tsfn.call_async)

**Today** (`src/routes.rs::build_action_envelope`):

```rust
ActionEnvelope {
    kind: "action",
    action_id: String,
    args_json: String,         // raw request body, validated UTF-8
    req: BrustRequest,
}
```

**After this sub-project:**

```rust
ActionEnvelope {
    kind: "action",
    action_id: String,
    content_type: String,      // NEW — request's Content-Type header value (or "" if absent)
    body_text: Option<String>, // PRESENT for application/json and application/x-www-form-urlencoded
    body_b64:  Option<String>, // PRESENT for multipart/form-data
    req: BrustRequest,
}
```

Invariant: exactly one of `body_text` / `body_b64` is `Some`. Encoded
in serde via `#[serde(skip_serializing_if = "Option::is_none")]`.

`args_json` is REMOVED. Worker-side dispatch updates accordingly (S3).

### 2.2 TS mirror (`runtime/routes.ts::RouteCall`)

```ts
type RouteCall =
  | { kind: 'render', ... }
  | {
      kind: 'action'
      action_id: string
      content_type: string
      body_text?: string
      body_b64?: string
      req: BrustRequest
    }
```

### 2.3 Why mutually-exclusive fields, not a sub-discriminator

Considered:

```ts
| { kind: 'action', subkind: 'json',  action_id, body_text, req }
| { kind: 'action', subkind: 'form-urlencoded', action_id, body_text, req }
| { kind: 'action', subkind: 'multipart', action_id, body_b64, content_type, req }
```

Rejected — the `content_type` field already discriminates within JS;
encoding the discrimination twice (in a `subkind` + `content_type`) adds
nothing. Mutually-exclusive optional fields keep the envelope schema
small and forward-extensible (a future XML body type just adds a third
optional field).

---

## 3. Rust side — body parsing

### 3.1 Content-Type extraction in `src/server.rs` action branch

Today, after reading the request body, Rust calls
`std::str::from_utf8(body_slice)` and 400s on non-UTF-8. After this
sub-project:

```rust
// 1. Parse the Content-Type header (default to empty if missing).
let content_type = parse_content_type(&buf[..header_end]).unwrap_or_default();

// 2. Branch on content_type. ASCII-lowercase the prefix for case-insensitive
//    matching (RFC 7231 says CT values are case-insensitive for type/subtype).
let ct_lower = content_type.to_ascii_lowercase();
let (body_text, body_b64): (Option<String>, Option<String>) = if ct_lower.is_empty()
    || ct_lower.starts_with("application/json")
    || ct_lower.starts_with("application/x-www-form-urlencoded")
{
    // Text body — UTF-8 validated.
    match std::str::from_utf8(body_slice) {
        Ok(s) => (Some(s.to_string()), None),
        Err(_) => { error_400; continue; }
    }
} else if ct_lower.starts_with("multipart/form-data") {
    // Binary body. base64-encode for transport through the JSON envelope.
    let b64 = base64::engine::general_purpose::STANDARD.encode(body_slice);
    (None, Some(b64))
} else {
    // Unsupported Content-Type → 415.
    let _ = s.write_all(http::error_415()).await;
    return;
};
```

Add `base64 = "0.22"` to `Cargo.toml` — it is NOT currently a transitive
dep of `napi-rs` (verified against `Cargo.lock`). Roughly 30 KB of code,
well-audited, single-purpose.

**Case-fold rationale:** the existing pre-MVP dispatcher accepts any
Content-Type (it just UTF-8-validates the body). The new spec narrows
that to a closed set — using `starts_with` against the ASCII-lowercase
form keeps `application/JSON; charset=UTF-8` and similar valid
variants accepted, matching what real-world clients send.

### 3.2 `parse_content_type` helper

Mirrors `parse_content_length` from session 5. Lowercase comparison is
intentional — Content-Type values are case-insensitive per RFC 7231.

```rust
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

### 3.3 `error_415` in `src/http.rs`

```rust
pub fn error_415() -> &'static [u8] {
    static B: &[u8] = b"HTTP/1.1 415 Unsupported Media Type\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
    B
}
```

Closes the connection (body is partially read; can't keep-alive).

### 3.4 `build_action_envelope` signature change

Same function name; new parameter list:

```
build_action_envelope(method, path, id, body_str, headers)
  ↓
build_action_envelope(method, path, id, content_type, body_text, body_b64, headers)
```

`body_text` and `body_b64` are passed as `Option<&str>` — exactly one is
`Some`. Update every existing envelope unit test (grep
`build_action_envelope` and `ActionEnvelope` in `src/routes.rs#[cfg(test)]`
to find them — count may be 2 or 3 depending on session 5's final state)
and add 3 new tests for the new shape branches: JSON path, form-urlencoded
path, multipart path.

### 3.5 Method gating unchanged

`POST` is the only allowed method on `/_brust/action/*` (existing
behaviour). No change to outer method check.

---

## 4. JS worker side — body decoding & FormData construction

### 4.1 `actionBranch` (`runtime/routes.ts`) — branch on content_type

```ts
async function actionBranch(call, byId, view, encoder) {
  const def = byId.get(call.action_id)
  if (!def) return notFound(...)

  let argsForFn: unknown[]
  try {
    if (call.body_b64 !== undefined) {
      // Multipart path — base64 → bytes → Web Request.formData()
      const bytes = base64Decode(call.body_b64)
      const fd = await new Request('http://x', {
        method: 'POST',
        headers: { 'Content-Type': call.content_type },
        body: bytes,
      }).formData()
      argsForFn = [fd]
    } else if (call.content_type.startsWith('application/x-www-form-urlencoded')) {
      const params = new URLSearchParams(call.body_text!)
      const fd = new FormData()
      for (const [k, v] of params) fd.append(k, v)
      argsForFn = [fd]
    } else {
      // JSON path (existing behaviour, validated array)
      const decoded = JSON.parse(call.body_text!) as unknown
      if (!Array.isArray(decoded)) return badJsonShape(...)
      argsForFn = decoded
    }
  } catch (e) {
    return badBody(...)
  }

  // Middleware + dispatch (unchanged downstream)
  const terminal = async () => { try { ... fn(req, ...argsForFn) ... } catch { 500 } }
  const chain = composeChain(req, def.middleware, terminal)
  return packResponse(view, encoder, await chain())
}
```

Helpers:
- `base64Decode` — use `Buffer.from(s, 'base64')` (universally available in Bun). Result is a `Buffer` which is a `Uint8Array` subclass — works directly as `body:` for the synthetic Request.
- `notFound`, `badJsonShape`, `badBody` — same JSON-error envelope helpers used today.

### 4.2 What the handler sees

| Request Content-Type | Handler's `args` shape |
|---|---|
| `application/json` | `[...whateverWasInTheJsonArray]` (existing) |
| `application/x-www-form-urlencoded` | `[FormData]` |
| `multipart/form-data; boundary=...` | `[FormData]` |

Handlers MUST declare a single `FormData` parameter if they intend to
receive forms. There is NO automatic positional unfolding of form
fields into parameters.

---

## 5. Client API (`runtime/client/index.ts`)

### 5.1 New `formAction<F>(id)` helper

Sits next to the existing `action<F>(id)`. Same zero-imports policy.

```ts
type FormActionFn<F> =
  F extends (req: any, fd: FormData) => infer R
    ? (fd: FormData) => R
    : never

export function formAction<F extends (req: any, fd: FormData) => unknown>(
  id: string,
): FormActionFn<F> {
  return (async (fd: FormData) => {
    if (!(fd instanceof FormData)) {
      throw new TypeError('formAction expects a FormData')
    }
    const res = await fetch(`/_brust/action/${encodeURIComponent(id)}`, {
      method: 'POST',
      // DO NOT set Content-Type manually — fetch sets multipart/form-data
      // with the correct boundary when body is a FormData. Setting it
      // manually loses the boundary and the server can't parse.
      body: fd,
    })
    const text = await res.text()
    if (!res.ok) {
      try {
        const err = JSON.parse(text) as { error?: { message?: string } }
        throw new BrustActionError(err.error?.message ?? text, res.status)
      } catch {
        throw new BrustActionError(text || res.statusText, res.status)
      }
    }
    return text ? JSON.parse(text) : undefined
  }) as FormActionFn<F>
}
```

Type-narrowing rule: if the server handler isn't shaped
`(req, fd: FormData) => R`, `FormActionFn<F>` becomes `never` and TS
flags the call site at compile time.

### 5.2 `action<F>(id)` unchanged

Existing JSON action helper keeps its shape. Apps that already use
`action<F>(id)` see no change.

### 5.3 Bundle impact

`formAction` adds ~30 LOC to `runtime/client/index.ts`. Still zero
external imports. Bundled per-island chunk grows by ~600 bytes
gzipped.

---

## 6. Body-cap semantics

`MAX_ACTION_BODY_BYTES = 256 * 1024` stays at 256 KB. This is the raw
request body size cap, BEFORE base64 encoding.

- A multipart body of exactly 256 KB → base64 string of ~341 KB → JSON
  envelope of ~341 KB + ~200 bytes for the rest. Passes through tsfn
  as a String (no envelope-size cap on the Rust→JS side; only the
  outbound response uses SAB).
- A JSON body of 256 KB → `body_text` of 256 KB. Same envelope budget.

Bodies above 256 KB → 413 Payload Too Large (existing behaviour,
unchanged).

---

## 7. Migration of existing actions + tests

### 7.1 No user-facing change for JSON actions

`brust.scanActions()` + `withMiddleware` + handler signature
`(req, ...args) => R` continues to work for JSON-only handlers. The
example app's `createNote`, `whoAmI`, `deleteNote`, `pingAction` need
ZERO changes.

### 7.2 Wire-format internal change

`args_json` removed from `ActionEnvelope`. Replaced by `body_text`.
This is internal — no public consumer touches the envelope directly.

Affected places (must update):
- Rust: `src/routes.rs::ActionEnvelope` + `build_action_envelope`
- Rust unit tests: any test asserting on envelope JSON shape (session 5
  added 3 tests in `src/routes.rs`)
- TS: `runtime/routes.ts::RouteCall` union
- TS dispatch: `runtime/routes.ts::actionBranch`

### 7.3 Demo additions to the example app

`example/hello-world/actions.ts`:

```ts
'use server'
// ... existing exports kept

export async function uploadAvatar(_req: BrustRequest, fd: FormData): Promise<{ name: string, size: number }> {
  const file = fd.get('file')
  if (!(file instanceof File)) throw new Error('file required')
  if (file.size > 200 * 1024) throw new Error('file too big (max 200 KB)')
  return { name: file.name, size: file.size }
}
```

`example/hello-world/components/AvatarUpload.tsx` — new island.
`example/hello-world/routes.tsx` — add `/avatar` route.
`example/hello-world/island.config.ts` — register `AvatarUpload`.

---

## 8. Error handling

| Condition | Status | Body |
|---|---|---|
| Body Content-Type is unsupported (not JSON / form-urlencoded / multipart) | 415 | empty (Rust-native) |
| Body Content-Type missing AND body is non-empty | 400 | "missing Content-Type" |
| body_text not valid JSON (when CT is application/json) | 400 | `{"error":{"message":"invalid args JSON"}}` |
| body_text JSON is not an array (when CT is application/json) | 400 | `{"error":{"message":"args must be a JSON array"}}` |
| body_b64 base64-decode fails | 400 | `{"error":{"message":"malformed multipart body"}}` |
| `Request.formData()` parse fails (bad boundary, truncated) | 400 | `{"error":{"message":"invalid form data: <msg>"}}` |
| Handler throws | 500 | `{"error":{"message":"<msg>","name":"<name>"}}` (existing) |
| Middleware short-circuits | from middleware response | from middleware response (existing) |
| Body > 256 KB | 413 | empty (Rust-native, existing) |

---

## 9. Testing

### 9.1 Rust unit tests (`src/routes.rs`)

Update existing 3 envelope tests for the new shape. Add:

- `build_action_envelope_json_path` — `content_type=application/json`, body in `body_text`, `body_b64` absent.
- `build_action_envelope_form_urlencoded_path` — `content_type=application/x-www-form-urlencoded; charset=UTF-8`, body in `body_text`.
- `build_action_envelope_multipart_path` — `content_type=multipart/form-data; boundary=xxx`, body in `body_b64` (base64-encoded), `body_text` absent.

`src/server.rs`:
- `parse_content_type_finds_header` (5 cases mirroring `parse_content_length_*`).

`src/http.rs`:
- `error_415_status` — verifies the status line + Connection: close.

### 9.2 Integration tests (`tests/integration.test.ts`)

Add 6 new tests after the existing 11 action tests (ports 38186-38191):

1. `action endpoint: form-urlencoded body → FormData arg` — POST with `Content-Type: application/x-www-form-urlencoded`, body `name=Alice&age=30`, action returns `{ok:true}` after reading `fd.get('name')`.
2. `action endpoint: multipart body → FormData with File` — POST with `multipart/form-data`, attach a small file, action returns the file name + size.
3. `action endpoint: unsupported Content-Type → 415` — POST with `application/xml`, expect 415.
4. `action endpoint: multipart with malformed body → 400` — POST with `multipart/form-data; boundary=abc`, body that doesn't match the boundary, expect 400 with form-data error message.
5. `action endpoint: JSON path unchanged` — sanity test that a JSON action still works after the envelope refactor (one curl from session 5 carries over).
6. `action endpoint: middleware runs for form actions` — auth middleware short-circuits a form action exactly like a JSON action.

### 9.3 Example app smoke

`/avatar` page renders the AvatarUpload island; client submits a tiny FormData; response body shows the uploaded filename + size.

---

## 10. Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Base64 decode API differs across runtimes | Low | Spec mandates `Buffer.from(s, 'base64')` — always available in Bun. No feature-detect needed. |
| Wire-format change breaks middleware-chain composition for forms | Low | `composeChain` is independent of args shape — it receives `req` only. Forms route through the same chain. |
| `Request.formData()` parsing on a Web Request constructed from raw bytes — does Bun support it? | Low | Bun 1.x supports `new Request(url, { body: Uint8Array }).formData()` per docs. Add a sanity unit test if uncertain. |
| Base64-encoding adds CPU cost to multipart path | Low | Acceptable for a 256 KB cap. Action endpoint is not the hot path (render is). |
| Large multipart envelope (~341 KB JSON string) through napi tsfn might surface a buffer issue | Low | tsfn passes the String unchanged; no copy-cap documented. Verify with the integration test using a 200 KB file. |
| Handler signature mismatch (declared `(req, fd: FormData)` but JSON request arrives) | Med | Documented in S4.2: handler is on the user to declare which shape it expects. JSON request → `argsForFn = [...args]`, handler sees first arg as whatever, behaves weirdly. NOT a framework concern; agentic schema in a future surface will surface this mismatch. |

---

## 11. Implementation order

Suggested task split for the plan phase (writing-plans will refine):

1. **Rust: `parse_content_type` helper + `error_415` + base64 dep** (~30 min).
2. **Rust: `build_action_envelope` rewrite + ActionEnvelope shape change + 4 new envelope tests + update existing 3 tests** (~1 h).
3. **Rust: `server.rs` action branch — branch on content_type + populate body_text/body_b64** (~1 h).
4. **JS: `RouteCall` type union update; `actionBranch` content-type branching + FormData construction** (~1 h).
5. **Client: `formAction<F>(id)` helper + zero-imports** (~30 min).
6. **Example app: `uploadAvatar` action + AvatarUpload island + /avatar route** (~1 h).
7. **Integration tests: 6 new form tests** (~1 h).
8. **`architecture.md` update — promote Forms to "Built"** (~15 min).

Total estimate: ~6 hours focused work via subagent-driven-development.

---

## 12. Open follow-ups (post-MVP)

Documented in S1 "Out of scope". Re-listing for the plan reader:

- Native HTML form support with HTML/303 responses.
- Streaming uploads (SAB resize protocol).
- Schema validation for form fields.
- CSRF token middleware.
- Progress reporting via SSE.
