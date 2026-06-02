# Plan — native loader HTTP status (notFound/redirect) + S12 411 fix

> Implements `docs/superpowers/specs/2026-06-02-native-loader-status-design.md`.
> Branch: `feat/native-loader-status`. TDD-shaped, sequential tasks.

## Baselines (must stay green throughout)
- `cargo fmt --all --check`
- `cargo clippy --workspace --all-targets --locked -- -D warnings`
- `cargo build --workspace --locked && cargo test --workspace --locked`
- `bun run ci` (biome)
- `bun test runtime/`
- `bun test tests/native-island.test.ts tests/native-island-ssr.test.ts tests/cli-new.test.ts tests/integration.test.ts`

⚠️ **After ANY `crates/` edit**: `cd runtime && bun run build` to regenerate `runtime/*.node`
+ `runtime/index.js` / `index.d.ts`. Stale `.node` silently uses the old binary (gitignored,
never shows in `git status`). This is load-bearing for Tasks 2, 4, 5, 6.

## Spec-coverage map
| Spec item | Task |
|---|---|
| S12 classify_request_body + 411 RFC fix | Task 1 |
| S9 napi_render_jinja status param | Task 2 |
| S9 TS sentinel helpers + exports | Task 3 |
| S9 wire document + nav branches | Task 4 |
| Integration tests (S9 + S12) | Task 5 |
| Dogfood pokedex + FRAMEWORK-GAPS | Task 6 |

---

## Task 1 — S12: `classify_request_body` helper + action-branch rewrite (Rust)

**File:** `crates/brust/src/server.rs`

**RED** — add unit tests in the existing `#[cfg(test)] mod tests` (near `parse_content_length`
tests ~1801):
```rust
#[test]
fn classify_body_missing_cl_is_empty() {
    let raw = b"DELETE /x HTTP/1.1\r\nHost: x\r\n\r\n";
    assert!(matches!(classify_request_body(raw), BodyClass::Empty));
}
#[test]
fn classify_body_with_cl_is_sized() {
    let raw = b"POST /x HTTP/1.1\r\nHost: x\r\nContent-Length: 7\r\n\r\n";
    assert!(matches!(classify_request_body(raw), BodyClass::Sized(7)));
}
#[test]
fn classify_body_transfer_encoding_is_chunked() {
    let raw = b"POST /x HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n";
    assert!(matches!(classify_request_body(raw), BodyClass::Chunked));
}
#[test]
fn classify_body_te_wins_over_cl() {
    let raw = b"POST /x HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\n";
    assert!(matches!(classify_request_body(raw), BodyClass::Chunked));
}
#[test]
fn classify_body_te_case_insensitive() {
    let raw = b"POST /x HTTP/1.1\r\nHost: x\r\ntransfer-encoding: Chunked\r\n\r\n";
    assert!(matches!(classify_request_body(raw), BodyClass::Chunked));
}
```
Run: `cargo test -p brust classify_body` → fails to compile (no `classify_request_body`).

**GREEN** — implement near `parse_content_length` (~1688):
```rust
#[derive(Debug, PartialEq)]
enum BodyClass {
    Empty,
    Sized(usize),
    Chunked,
}

/// Classify a request body per RFC 7230 §3.3.3: Transfer-Encoding wins over
/// Content-Length; absent both → no body. We do not support chunked decoding,
/// so Chunked is surfaced for the caller to reject.
fn classify_request_body(header: &[u8]) -> BodyClass {
    if header_has_transfer_encoding(header) {
        return BodyClass::Chunked;
    }
    match parse_content_length(header) {
        Some(n) => BodyClass::Sized(n),
        None => BodyClass::Empty,
    }
}

/// True if a `Transfer-Encoding` header is present (any value). Mirrors
/// parse_content_length's httparse-based header walk.
fn header_has_transfer_encoding(header: &[u8]) -> bool { /* walk headers, case-insensitive name match */ }
```
Implement `header_has_transfer_encoding` the same way `parse_content_length` walks headers
(httparse or the existing manual parser — match whatever `parse_content_length` uses; read it
first). 

**Rewrite the action branch** (~363–376). Replace:
```rust
let content_length = match parse_content_length(&buf[..header_end]) {
    Some(n) => n,
    None if matches!(m, Method::Get | Method::Head) => 0,
    None => { let _ = s.write_all(http::error_411()).await; return; }
};
if content_length > tuning().max_action_body_bytes {
    let _ = s.write_all(http::error_413()).await; return;
}
```
with:
```rust
let content_length = match classify_request_body(&buf[..header_end]) {
    // We don't decode chunked bodies — ask the client for a Content-Length.
    BodyClass::Chunked => { let _ = s.write_all(http::error_411()).await; return; }
    BodyClass::Sized(n) if n > tuning().max_action_body_bytes => {
        let _ = s.write_all(http::error_413()).await; return;
    }
    BodyClass::Sized(n) => n,
    BodyClass::Empty => 0,
};
```
(The 413 cap now lives inside the match; remove the old standalone `if content_length >` check
to avoid duplication.)

**Leave the MCP branch (~516) unchanged.**

**Verify:**
- `cargo test -p brust` (new unit tests pass)
- `cargo clippy --workspace --all-targets --locked -- -D warnings`
- `cargo fmt --all --check`
- `cd runtime && bun run build` (regenerate .node — S12 is reached on the hot path)

**Commit:** `fix(server): RFC 7230 bodyless request handling — no spurious 411 (S12)`

**ESCALATE if:** `parse_content_length` turns out not to use a reusable header-walk you can
mirror, or the 413 cap relocation conflicts with a downstream assumption.

---

## Task 2 — S9: `napi_render_jinja` status param (Rust)

**File:** `crates/brust/src/lib.rs` (~840)

Add a trailing positional param and use it in the success-branch meta only:
```rust
pub fn napi_render_jinja(
    worker_id: u32,
    data_len: u32,
    template_name: String,
    status: Option<u32>,            // NEW — None → 200
) -> NapiResult<u32> {
    ...
    Ok(html) => {
        let meta = serde_json::json!({
            "status": status.unwrap_or(200),   // was hardcoded 200
            "contentType": "text/html; charset=utf-8",
            "headers": {},
            "streaming": false,
        });
        ...
    }
    // Err(...) branch → 500 UNCHANGED. SAB-overflow branch → 500 UNCHANGED.
}
```
napi-rs maps `Option<u32>` → `number | undefined | null` (proven in-tree: `island_cache_set`
`ttl_ms: Option<u32>` → `ttlMs?` in index.d.ts). Trailing optional → TS callers may omit it.

**Verify:**
- `cargo build --workspace --locked`, clippy, fmt
- `cd runtime && bun run build` → then confirm the regenerated `runtime/index.d.ts` shows
  `napiRenderJinja(workerId: number, dataLen: number, templateName: string, status?: number | undefined | null): number`
  (grep it). Do NOT hand-edit index.js/index.d.ts.

**Commit:** `feat(jinja): napi_render_jinja accepts optional status (S9 foundation)`

**ESCALATE if:** the regenerated binding signature doesn't include the new param (napi build
cache / wrong build profile) — rebuild clean before pivoting.

---

## Task 3 — S9: TS sentinel helpers + unit tests + exports

**Files:** `runtime/routes.ts`, `runtime/index.ts`, new `runtime/native-verdict.test.ts`

**RED** — `runtime/native-verdict.test.ts`:
```ts
import { test, expect } from 'bun:test'
import { notFound, redirect, isNativeVerdict } from './routes.ts'

test('notFound() → 404 verdict, render true, empty data', () => {
  const v = notFound()
  expect(isNativeVerdict(v)).toBe(true)
  expect(v.status).toBe(404)
  expect(v.render).toBe(true)
  expect(v.data).toEqual({})
})
test('notFound(data) carries data', () => {
  const v = notFound({ user: 'bob' })
  expect(v.data).toEqual({ user: 'bob' })
})
test('redirect() → 302, render false, Location header', () => {
  const v = redirect('/x')
  expect(v.status).toBe(302)
  expect(v.render).toBe(false)
  expect(v.headers).toEqual({ Location: '/x' })
})
test('redirect(url, 301) → 301', () => {
  expect(redirect('/x', 301).status).toBe(301)
})
test('isNativeVerdict false for plain / null / data with status key', () => {
  expect(isNativeVerdict(null)).toBe(false)
  expect(isNativeVerdict({})).toBe(false)
  expect(isNativeVerdict({ status: 404 })).toBe(false) // symbol-keyed guard, not the plain key
})
```
Run: `bun test runtime/native-verdict.test.ts` → fails (no exports).

**GREEN** — in `runtime/routes.ts` (near the top-level type exports, after `RouteResponse`):
```ts
const BRUST_VERDICT = Symbol.for('brust.nativeVerdict')

export interface NativeVerdict {
  readonly [BRUST_VERDICT]: true
  readonly status: number
  readonly render: boolean
  readonly data?: unknown
  readonly headers?: Record<string, string>
}

/** Return from a native (`native: true`) route loader to render the route's own
 * template with HTTP 404. `data` becomes the template context. */
export function notFound(data?: unknown): NativeVerdict {
  return { [BRUST_VERDICT]: true, status: 404, render: true, data: data ?? {} }
}

/** Return from a native route loader to emit a redirect (no template render). */
export function redirect(
  location: string,
  status: 301 | 302 | 303 | 307 | 308 = 302,
): NativeVerdict {
  return { [BRUST_VERDICT]: true, status, render: false, headers: { Location: location } }
}

export function isNativeVerdict(x: unknown): x is NativeVerdict {
  return typeof x === 'object' && x !== null && (x as Record<symbol, unknown>)[BRUST_VERDICT] === true
}
```
In `runtime/index.ts` (~685, alongside the `defineRoutes, makeRenderer, Outlet` re-export):
```ts
export { defineRoutes, makeRenderer, Outlet, notFound, redirect, isNativeVerdict } from './routes.ts'
```
and add `NativeVerdict` to the type re-export block (~686–695).

**Verify:** `bun test runtime/native-verdict.test.ts`; `bun run ci` (biome).

**Commit:** `feat(routes): notFound()/redirect() native loader sentinels (S9)`

---

## Task 4 — S9: wire document render branch + nav branch

**File:** `runtime/routes.ts` (no new tests here — covered by Task 5 integration)

**(a) Document render branch** (~599–694). Right after the loader runs and BEFORE
`JSON.stringify(data)` (~617), and after the loader-error try/catch:
```ts
let renderStatus: number | undefined
if (isNativeVerdict(data)) {
  if (!data.render) {
    // redirect — no template render, fast-lane packed response.
    return packSingleChunkResponse(view, encoder, {
      status: data.status,
      contentType: 'text/html; charset=utf-8',
      body: '',
      headers: data.headers,
    })
  }
  // notFound — render the route's own template with 404.
  renderStatus = data.status
  data = data.data ?? {}
}
```
Then thread `renderStatus` into BOTH `napiRenderJinja` call sites:
- the manifest branch (~654): `(native as any).napiRenderJinja(Number(workerId), finalBytes.length, flat.nativeTemplate, renderStatus)`
- the plain branch (~682): `(native as any).napiRenderJinja(Number(workerId), dataBytes.length, flat.nativeTemplate, renderStatus)`

⚠️ Both call sites — patching only one is a silent bug (notFound would render 200 on whichever
branch you missed). `data` is currently `const`? Check — if `let data: unknown = {}` it's
mutable (it is, ~600). Keep it `let`.

**(b) SPA nav branch** — `renderNativeRouteToHtml` (~950). After `data = await leaf.loader(...)`
(~962) and before `ctx = (data ?? {})` (~965):
```ts
if (isNativeVerdict(data)) {
  // SPA nav can't emit a redirect/404 in-place; force the client's full-reload
  // fallback so the document path produces the authoritative status.
  throw new Error('native verdict on SPA navigation — falling back to full reload')
}
```

**Verify:** `bun test runtime/` (no regression); `bun run ci`.

**Commit:** `feat(routes): honor native verdicts in document + nav render paths (S9)`

**ESCALATE if:** `data` is not reassignable at the document branch, or `packSingleChunkResponse`
is out of scope at the insertion point (it's defined in the same module ~1054, should be fine).

---

## Task 5 — Integration tests (S9 + S12)

**Files:** `tests/fixtures/app/routes.tsx`, `tests/integration.test.ts`

**(a) Fixture routes** — add to `routes.tsx`, REUSING the existing `NativeProfile` component
(its `.jinja` is already compiled — no fixture rebuild needed; templateName = Component.name):
```tsx
// S9 — native loader status sentinels. Reuse NativeProfile's template.
{
  path: '/_test/native-notfound/{user}',
  Component: NativeProfile,
  native: true,
  loader: async ({ params }: { params: { user: string } }) =>
    notFound({ user: params.user, greeting: `Hello, ${params.user}` }),
},
{
  path: '/_test/native-redirect',
  Component: NativeProfile,
  native: true,
  loader: async () => redirect('/_test/native/landed'),
},
```
Import `notFound, redirect` at the top of `routes.tsx`:
`import { defineRoutes, notFound, redirect, type Middleware } from '../../../runtime/routes.ts'`

**(b) S9 integration tests** (use the shared server — read-only GETs):
```ts
test('native loader notFound() → 404 with rendered template', async () => {
  const resp = await fetch(`http://127.0.0.1:${shared!.port}/_test/native-notfound/bob`)
  expect(resp.status).toBe(404)
  const html = await resp.text()
  expect(html).toContain('Hello, bob')      // NativeProfile renders greeting
})
test('native loader redirect() → 302 + Location, empty body', async () => {
  const resp = await fetch(`http://127.0.0.1:${shared!.port}/_test/native-redirect`, { redirect: 'manual' })
  expect(resp.status).toBe(302)
  expect(resp.headers.get('location')).toBe('/_test/native/landed')
  expect(await resp.text()).toBe('')
})
test('native loader normal return → 200 (no regression)', async () => {
  const resp = await fetch(`http://127.0.0.1:${shared!.port}/_test/native/alice`)
  expect(resp.status).toBe(200)
})
```
(Confirm the shared server is in scope; if these routes mutate nothing, shared is fine. If the
manual-redirect fetch option misbehaves under Bun, fall back to `startServer()`.)

**(c) S12 — UPDATE the existing 411 test and ADD two.** ⚠️ TEST-DESIGN CRITICAL:
- The existing test `'action endpoint: missing Content-Length → 411'` (~589) encodes the OLD
  behavior. After the fix, a bodyless POST is NOT 411 — it reaches the handler with an empty
  body and fails downstream (JSON parse of `''`). **Reproduce the real status first**
  (debug-mantra step 1) by running the raw-socket POST against a booted fixture, then rewrite
  the assertion to the ACTUAL new status (expected: NOT 411; likely 400). Rename the test to
  `'action endpoint: missing Content-Length → no longer 411 (RFC bodyless)'`.
- **ADD** (raw socket — `fetch` sets `Content-Length: 0` so it CANNOT reproduce S12; must use a
  hand-crafted request like the 411/413 tests):
```ts
test('action endpoint: bodyless DELETE without Content-Length → 200 (S12)', async () => {
  // Raw socket: a bodyless DELETE that omits Content-Length entirely (browsers/treaty do this).
  // fetch() would add Content-Length: 0 and mask the bug.
  // DELETE /notes/{id} is gated by requireUser → send the cookie.
  // ... Bun.connect, write:
  //   'DELETE /_brust/action/notes/n-1 HTTP/1.1\r\nHost: x\r\nCookie: user=alice\r\n\r\n'
  // expect status line to contain '200'
})
test('action endpoint: Transfer-Encoding chunked → 411 (unsupported)', async () => {
  // Raw socket: 'POST /_brust/action/notes HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n'
  // expect status line to contain '411'
})
```
  Model the raw-socket plumbing on the existing 411 test (~589–624). For the DELETE 200 test,
  the body slice is empty → handler runs with no body → middleware passes (cookie) → returns
  `{ ok: true, id: 'n-1' }`.

Also update the comment at ~510 that lists "411 / 413 / missing" guards to reflect the new
RFC-compliant behavior.

**Verify:**
- `bun test tests/integration.test.ts`
- `bun test tests/native-island.test.ts tests/native-island-ssr.test.ts` (they `brust build` the
  fixture — adding NativeProfile-reusing routes must not break the build; if the build complains
  about duplicate templates, ESCALATE).

**Commit:** `test: native verdict 404/302 + S12 bodyless/chunked integration coverage`

**ESCALATE if:** `brust build` rejects two routes sharing one native Component, or the manual
redirect fetch can't observe the 302 under Bun (pivot to raw socket).

---

## Task 6 — Dogfood pokedex + FRAMEWORK-GAPS

**Files:** `example/pokedex/lib/loaders.ts`, `example/pokedex/FRAMEWORK-GAPS.md`

**(a) loaders.ts** — wrap the detail 404 return as a verdict. Read the current
`detailLoader` (~88) and `emptyDetail` (~179). Change the not-found return path:
```ts
import { notFound } from 'brustjs/routes'   // confirm import style matches existing imports
// ...
if (!p) return notFound(emptyDetail(name))   // was: return emptyDetail(name)
```
**KEEP** the `notFound: boolean` field on `DetailData` and the `notFound: false` on the success
return — `DetailPage.tsx` still branches on the flag (S11 conditional). The sentinel only sets
HTTP status; the flag still drives template branching. Removing it breaks the template.

**(b) FRAMEWORK-GAPS.md** — move S9 and S12 from "ยังเปิด" to FIXED:
- Update the "สถานะรวม" counts and the "ยังเปิด" list (drop S9, S12).
- Rewrite the S9 (◆) and S12 (★) sections with `✅ FIXED` status, the fix summary
  (notFound/redirect sentinels + napi status param; RFC 7230 bodyless), and replace the
  workaround note (`.delete({})` is no longer required for bodyless; `notFound: true` flag is
  no longer the status mechanism).

**Verify:**
- `bun run ci` (biome) for the TS change
- Build + manual smoke happens in Phase 6 (orchestrator): `brust build` pokedex →
  `curl -s -o /dev/null -w '%{http_code}' /pokemon/<bad>` → `404`.

**Commit:** `feat(pokedex): dogfood notFound() on detail 404; mark S9+S12 FIXED`

---

## Final integration gate (Phase 6, orchestrator-run)
Re-run ALL baselines (top of plan) + manual smoke:
- pokedex `/pokemon/<bad>` → 404 (was 200)
- a valid pokemon → 200
- raw-socket bodyless DELETE → 200
Then `finishing-a-development-branch`: PR → green CI → (user merges).
