# Server Functions (MVP) — Design Spec

**Sub-project:** Tier-2 follow-up. Flagship feature unlocked by Islands MVP.
**Date:** 2026-05-24
**Status:** approved for implementation planning
**Parent design:** `architecture.md` S "Server functions"
**Related plans:** `2026-05-24-islands-hydration.md` (provides client-side hydration surface this MVP wires actions into), middleware/header-mutation plan (provides `Middleware` type + chain composition)

---

## 1. Overview & Scope

### Goal

Allow per-process registered async functions to be invoked from a hydrated island via a transparent typed RPC call. Same Rust accept loop + worker pool. JSON args / JSON return. No separate API gateway.

```tsx
// server side
async function createNote(req: BrustRequest, text: string): Promise<{ id: string }> {
  return { id: 'n-' + Date.now() }
}
brust.registerActions([{ id: 'createNote', fn: createNote }])

// client side (island component)
import { action } from 'brust/client'
import type * as srv from '../actions'
const createNote = action<typeof srv.createNote>('createNote')
await createNote('hello')                            // typed Promise<{ id: string }>
```

### Success criterion

> Running the example app, an island mounted on `/note` calls
> `await createNote('hi')` over `POST /_brust/action/createNote`, receives
> `{ id: 'n-...' }` JSON, and updates the DOM — all in under 5 ms p99 on
> localhost. The same action gated by an `authRequired` middleware returns
> 401 when called without a cookie.

### Concrete acceptance

```bash
# action call
$ curl -s -X POST -H 'content-type: application/json' \
  --data '["hello"]' http://127.0.0.1:38900/_brust/action/createNote
{"id":"n-1716527812345"}

# middleware short-circuit
$ curl -si -X POST -H 'content-type: application/json' \
  --data '[]' http://127.0.0.1:38900/_brust/action/protectedAction | head -1
HTTP/1.1 401 Unauthorized

# wrong method
$ curl -si http://127.0.0.1:38900/_brust/action/createNote | head -1
HTTP/1.1 405 Method Not Allowed

# unknown id
$ curl -si -X POST --data '[]' http://127.0.0.1:38900/_brust/action/missing | head -1
HTTP/1.1 404 Not Found

$ bun test
✓ all integration tests pass (existing 18 + N new action tests)

$ cargo test --lib
✓ all unit tests pass (existing 31 + N new Rust unit tests)
```

### MVP scope decisions (locked during brainstorm 2026-05-24)

| Decision | Choice | Rationale |
|---|---|---|
| Build-time scanner | **Defer** — manual `registerActions([...])` array | Mirror Islands MVP. Cuts plan from ~3d to ~1.5–2d. `"use server"` transform is a separate follow-up. |
| Worker dispatch | **Reuse render tsfn, extend envelope `kind`** | No new napi entry. Recycles middleware-chain composition. One SAB per worker stays one SAB. |
| Middleware on action | **Action-specific only** — no route inheritance | Avoid the X-Brust-Route header hack. Mirrors per-route middleware contract. |
| FormData / multipart | **Defer** — JSON-only | Forms plan owns multipart. Action MVP is the JSON path. |
| Client invocation surface | **Approach A** — `action<F>(id)` helper + `import type * as srv` | Smallest API; preserves types via TS generics + `import type` erase. |

### Out of scope (deferred)

1. **`"use server"` directive + auto-rewrite** — separate follow-up plan (~2d).
2. **`.brust/actions.ts` codegen** — needs scanner; folds into #1.
3. **Per-route middleware inheritance** (X-Brust-Route header) — defer until proven need.
4. **FormData / multipart** — Forms plan (~1d, depends on this MVP).
5. **`BRUST_DEBUG_ERRORS=1` stack-trace mode** — minor, defer.
6. **Action id collision detection at build time** — runtime throw is enough for MVP.
7. **Custom Content-Type per action** (binary returns) — JSON-only by contract.
8. **Streaming action responses** — depends on HTML Streaming plan.
9. **Action-level cache** — actions mutate state; not a roadmap item.
10. **Agentic surface manifest** — separate Tier-2 plan, depends on this MVP shipping ids.
11. **General Content-Type override for middleware short-circuits** — fixed in the broader "richer headers" follow-up; MVP uses `text/plain` for short-circuit bodies.

---

## 2. Architecture & data flow

```
Client island                Rust accept loop              Bun worker (renderer tsfn)
─────────────                ─────────────────             ──────────────────────────
fetch POST                   parse_request                 envelope.kind === 'action'
/_brust/action/<id>          match URL prefix              → byId Map lookup
body: JSON args              build ActionEnvelope:         → compose middleware chain
                             { kind: 'action', action_id,    (right-to-left, same as route)
                               args, req }                 → terminal: fn(req, ...args)
                             pick worker from pool         → JSON.stringify(returnValue)
                             tsfn.call(envelope) ──────►   → write SAB:
                                                              [meta_len u16 BE]
                             read SAB back from worker  ◄──   [meta JSON]
                             extract meta + body              [body = return JSON]
build_response          ◄──  Content-Type from meta
HTTP 200 (or status from         (default 'application/json'
meta) + body                      for action kind)

fetch.then(res.json)    ◄── ...

throws BrustActionError      (if non-2xx response, parse error envelope)
```

**Key invariants:**

- Same accept loop and worker pool as page rendering — no separate transport, no new napi entry.
- Envelope discriminator `kind: 'render' | 'action'` switches at JS side inside `makeRenderer`.
- Action handler signature: `(req: BrustRequest, ...args: unknown[]) => Promise<unknown>`. First arg is **always** `req`; the client stub strips it from the call site.
- Args ship as a JSON array: `[arg1, arg2, ...]`. Worker calls `fn(req, ...JSON.parse(args))`.
- Return value is `JSON.stringify`'d into the SAB body. Empty/`undefined` return → empty body, HTTP 200.

---

## 3. Wire format & envelope

### Worker-bound envelope (JSON sent into the renderer tsfn)

```ts
// runtime/routes.ts — RouteCall becomes a discriminated union
export type RouteCall =
  | { kind: 'render'; route_id: number; path: string; params: Record<string, string>; req: BrustRequest }
  | { kind: 'action'; action_id: string;                  args_json: string;            req: BrustRequest }
```

- Existing render envelope grows a `kind: 'render'` discriminant (explicit; no optional fields).
- Action id charset: `[A-Za-z0-9_-]+` (matches `isValidIslandId` rule). Validated in both Rust (URL parser) and JS (`registerActions`).
- **Wire shape for args is the raw UTF-8 request body as a JSON string field** (`args_json`), NOT a pre-decoded array. Rust does not parse the args body; it only validates UTF-8 and Content-Length. JS does exactly one `JSON.parse(args_json)` in the action branch of `makeRenderer`, before middleware runs. After the parse, JS verifies the result is an array (`Array.isArray`) — anything else → 400. Rationale: keeps Rust agnostic about user payload shape; lets the parse error surface as a 400 at JS without doubling work.

### SAB return shape (unchanged structure, new field)

```
[meta_len: u16 BE][meta JSON UTF-8][body bytes]

meta = { status: number, headers?: Record<string,string>, contentType?: string }
```

- Render path: `contentType` undefined → Rust uses default `text/html; charset=utf-8` (current behaviour).
- Action path: JS sets `contentType: 'application/json; charset=utf-8'` for normal returns.
- Middleware short-circuits on an action that don't override `contentType` → default `text/plain; charset=utf-8` for raw string bodies.
- **Side benefit:** the deferred Content-Type problem flagged in session 4's handoff is partially solved by this field. Render-path overrides via middleware can also set `contentType` going forward (route MVP did not need it but the wire is now ready).

### Rust dispatcher (`src/server.rs`)

New URL match in `handle_conn` before the route-table lookup:

```rust
// pseudo
match (method, path) {
    (POST, p) if p.starts_with("/_brust/action/") => {
        let id = &p["/_brust/action/".len()..];
        if !is_safe_action_id(id) { return error_4xx(404, "not found"); }
        if !action_registry.contains(id) { return error_4xx(404, "not found"); }
        if content_length > sab_cap { return error_4xx(413, "payload too large"); }
        if !content_length_present { return error_4xx(411, "length required"); }
        let body = read_body_utf8()?;            // 400 if not utf-8
        let envelope = ActionEnvelope { kind: "action", action_id: id, args: body, req };
        dispatch_to_worker(envelope);
    }
    (GET | HEAD | _, p) if p.starts_with("/_brust/action/") => error_4xx(405, "method not allowed"),
    _ => fallthrough,
}
```

`is_safe_action_id` mirrors `is_safe_island_filename` (`[A-Za-z0-9_-]+`, no path separators, no dots, max length cap).

`action_registry` is a new `HashSet<String>` in `lib.rs::State` populated by a new napi method `register_actions(ids: Vec<String>)`.

---

## 4. Server-side API (TypeScript)

```ts
// runtime/actions.ts — new file
import type { BrustRequest, Middleware } from './routes.ts'

export type ActionFn<Args extends unknown[] = unknown[], R = unknown> =
  (req: BrustRequest, ...args: Args) => Promise<R>

export interface ActionDef<F extends ActionFn = ActionFn> {
  /** Stable id; must match the id used by `action<F>(id)` on the client.
   * Charset: [A-Za-z0-9_-]+ (enforced; mirrors island id). */
  id: string
  /** Handler. Receives req + JSON-decoded args. */
  fn: F
  /** Per-action middleware chain. Same Middleware type used by routes. */
  middleware?: Middleware[]
}

/** Identity helper, parallels defineRoutes. */
export function defineActions(actions: ActionDef[]): ActionDef[] {
  return actions
}
```

```ts
// runtime/index.ts — additions
export { defineActions } from './actions.ts'
export type { ActionDef, ActionFn } from './actions.ts'

// brust object additions
brust.registerActions(actions: ActionDef[]): number
// Validates ids (charset + duplicates) and calls native register_actions(ids).
// Returns the count registered. Throws on validation failure.
```

```ts
// runtime/routes.ts — makeRenderer signature grows
export interface MakeRendererOptions {
  getWorkerId?: () => number | null
  actions?: ActionDef[]            // NEW — worker-side action table
}

export function makeRenderer(
  routes: Route[],
  view: Uint8Array,
  opts: MakeRendererOptions = {},
): (envelopeJson: string) => Promise<number>
```

The worker-side `actions` array is given to `makeRenderer` because the renderer tsfn handles BOTH render and action calls. Main-thread `brust.registerActions(...)` exists separately so Rust knows the URL → action_id table.

### Example shape (`example/hello-world`)

```ts
// example/hello-world/actions.ts
import type { BrustRequest } from '../../runtime/routes.ts'

export async function createNote(req: BrustRequest, text: string): Promise<{ id: string }> {
  if (text.length > 1000) throw new Error('too long')
  return { id: 'n-' + Date.now() }
}

export async function whoAmI(req: BrustRequest): Promise<{ user: string | null }> {
  return { user: req.cookies['user'] ?? null }
}
```

```ts
// example/hello-world/index.ts
import { createNote, whoAmI } from './actions'

const actions = [
  { id: 'createNote', fn: createNote },
  { id: 'whoAmI', fn: whoAmI },
]

if (!isWorker) {
  // ...existing setup
  brust.registerActions(actions)
  await brust.serve({ ... })
} else {
  const renderer = makeRenderer(routes, view, { actions, getWorkerId: () => wid })
  brust.registerRenderer(view, renderer)
}
```

---

## 5. Client-side API (TypeScript)

```ts
// runtime/client/index.ts — NEW entry point for browser bundles
// (no React, no server-side imports — minimal surface)

export type ServerFn = (req: any, ...args: any[]) => Promise<any>

/** Drop the leading `req` arg from F's parameter list. */
type DropReq<F> = F extends (req: any, ...args: infer A) => infer R
  ? (...args: A) => R
  : never

export function action<F extends ServerFn>(id: string): DropReq<F> {
  return ((...args: unknown[]) =>
    fetch(`/_brust/action/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    }).then(async (res) => {
      const text = await res.text()
      if (!res.ok) {
        const parsed = safeParse(text)
        const message = parsed?.error?.message ?? text ?? 'action failed'
        throw new BrustActionError(message, res.status, parsed ?? text)
      }
      return text ? JSON.parse(text) : undefined
    })) as DropReq<F>
}

export class BrustActionError extends Error {
  constructor(message: string, public status: number, public payload: unknown) {
    super(message)
    this.name = 'BrustActionError'
  }
}

function safeParse(s: string): { error?: { message: string } } | null {
  try { return JSON.parse(s) } catch { return null }
}
```

### Usage inside an island component

```tsx
// example/hello-world/components/NoteForm.tsx
import { useState } from 'react'
import { action } from '../../../runtime/client'
import type * as srv from '../actions'   // type-only — erased before bundling

const createNote = action<typeof srv.createNote>('createNote')

export default function NoteForm() {
  const [text, setText] = useState('')
  const [created, setCreated] = useState<string | null>(null)
  return (
    <form onSubmit={async (e) => {
      e.preventDefault()
      const { id } = await createNote(text)
      setCreated(id)
      setText('')
    }}>
      <input value={text} onChange={(e) => setText(e.target.value)} />
      <button>Save</button>
      {created && <span>created {created}</span>}
    </form>
  )
}
```

### Island bundling implications

- `runtime/islands/build.ts` already runs `Bun.build` per island with `react`, `react/jsx-runtime`, `react-dom/client` as externals. Adding `runtime/client` to the **bundled** set (not external) means each island chunk that imports `action` carries ~1 KB of client helper code. Acceptable for MVP.
- Future optimisation (defer): emit `runtime/client` as a shared chunk `/_brust/islands/_brust-client.js`, list it in the importmap, mark `runtime/client` external in island builds. Out of scope for this MVP.

---

## 6. Error model

### Server-side outcomes

| Source | HTTP status | Body |
|---|---|---|
| `fn(req, ...args)` returns normally | 200 | `JSON.stringify(returnValue)` (empty if `undefined`) |
| `fn(req, ...args)` throws | 500 | `{ "error": { "message": String(err), "name": err.name } }` |
| Middleware throws | 500 | Same as above (caught by makeRenderer outer try/catch) |
| Middleware short-circuits with explicit `{ status: 401, body: 'unauthorised' }` | 401 | raw body string (default `text/plain` Content-Type) |
| `JSON.parse(args)` fail at JS | 400 | `{ "error": { "message": "invalid args JSON" } }` |
| JS panics in unexpected way | 500 | `{ "error": { "message": "internal error" } }` |

### Rust-side pre-dispatch failures

| Condition | Status | Body |
|---|---|---|
| Method ≠ POST on `/_brust/action/*` | 405 | `method not allowed` |
| Body size > SAB capacity | 413 | `payload too large` |
| `Content-Length` header missing | 411 | `length required` |
| Action id fails charset `[A-Za-z0-9_-]+` | 404 | `not found` |
| Action id not in registry | 404 | `not found` |
| Body not valid UTF-8 | 400 | `invalid utf-8 body` |

### Client helper `action<F>(id)`

- HTTP 2xx → resolves with `JSON.parse(body)` (or `undefined` for empty body)
- HTTP non-2xx → throws `BrustActionError(message, status, payload)`
- Network/fetch failure → propagates the underlying error (caller catches)
- Caller pattern:
  ```ts
  try {
    await createNote(text)
  } catch (e) {
    if (e instanceof BrustActionError && e.status === 401) location.href = '/login'
    else throw e
  }
  ```

### Stack traces

Default: server does not include stack in the error envelope (leak risk). Adding `BRUST_DEBUG_ERRORS=1` to add `stack` field is **out of scope** for MVP. Logging the full error to stderr (`console.error('[brust] action <id> threw:', err)`) ships in MVP — mirrors render path.

---

## 7. Middleware + cache + req shape

### Middleware

Reuses the existing `Middleware` type and chain composition from the per-route middleware plan. Identical right-to-left composition, identical short-circuit semantics.

```ts
const requireAuth: Middleware = async (req, next) => {
  if (!req.cookies['user']) return { status: 401, body: 'unauthorised' }
  return next()
}

brust.registerActions([
  { id: 'createNote', fn: createNote, middleware: [requireAuth] },
])
```

### Cache

- Actions are **never cached** in MVP.
- `cache?` field is not allowed in `ActionDef`.
- The existing route cache (`/_brust/cache/...` endpoints) does not touch action paths.

### `req` shape for action calls

| Field | Value |
|---|---|
| `req.method` | `'POST'` |
| `req.url` | `/_brust/action/<id>` (raw — including any query string) |
| `req.headers` | All request headers, lower-cased |
| `req.cookies` | Parsed from Cookie header |
| `req.search` | Parsed query string (action can use `?dryRun=1` patterns) |
| `params` | **Not present** — actions don't use matchit |

The action handler receives `req` directly as its first arg (NOT inside a `RouteContext` wrapper) — actions don't render, so the context shape doesn't apply.

---

## 8. Testing strategy

### Rust unit tests (`src/server.rs` and `src/routes.rs` inline)

- URL parse `/_brust/action/<id>` — extract id from path
- Charset guard accepts `[A-Za-z0-9_-]+`, rejects `..`, `/`, `.`, empty, > N chars
- Method 405 on GET/PUT/DELETE/HEAD/OPTIONS
- Content-Length missing → 411
- Content-Length > cap → 413
- Body not utf-8 → 400
- Action id not in registry → 404
- ActionEnvelope JSON encode round-trip

### TypeScript unit tests (inline `bun:test` describes inside `runtime/routes.test.ts` if exists, else `tests/integration.test.ts`)

- `makeRenderer` action branch:
  - happy path: fn returns value → SAB body = JSON, meta.contentType = `application/json`
  - fn throws → SAB body = `{"error":{...}}`, meta.status = 500
  - middleware short-circuits → meta.status = chosen, body = raw
  - middleware mutates response headers → meta.headers reflects change
- `registerActions` validation:
  - duplicate id → throws
  - invalid charset → throws
  - empty array → ok (registers 0)
- `action<F>(id)` helper:
  - 200 → resolves with parsed JSON
  - 4xx with JSON error envelope → throws BrustActionError with payload
  - 4xx with plain text body → throws BrustActionError with text payload
  - 5xx → throws BrustActionError
  - Network fail (mock fetch reject) → propagates error

### Integration tests (`tests/integration.test.ts`)

- `POST /_brust/action/createNote` with valid JSON args → 200 + parsed return JSON
- `POST` same with malformed JSON → 400 with error envelope
- `POST` with unknown action id → 404
- `POST` with bad charset id (e.g. `..`) → 404
- `GET /_brust/action/createNote` → 405
- `POST` with `Content-Length` > cap → 413
- Action middleware short-circuits: `protectedAction` without cookie → 401
- Action middleware adds header post-`next()`: response carries `x-action-ms`
- Pages that don't use islands still ship zero action-related JS (regression check)

### End-to-end through example app

- `/note` page renders a `NoteForm` island (hydrate=load)
- Test hits `/note`, parses HTML for the island marker, then issues `POST /_brust/action/createNote` and asserts the JSON return shape
- Curl-driven; no headless browser needed

### Coverage target

Every wire-status code listed in S6 has a test. One happy-path end-to-end through the example app.

---

## 9. Files touched

### New source files (committed)

- `runtime/actions.ts` — `ActionDef`, `ActionFn`, `defineActions` helper
- `runtime/client/index.ts` — `action<F>(id)` helper + `BrustActionError`
- `example/hello-world/actions.ts` — `createNote`, `whoAmI` demos
- `example/hello-world/components/NoteForm.tsx` — island that calls `createNote`
- `example/hello-world/components/WhoAmI.tsx` — island that calls `whoAmI`

### Modified source files

- `runtime/index.ts` — re-export `defineActions`, `ActionDef`, `ActionFn`; add `brust.registerActions`
- `runtime/routes.ts` — make `RouteCall` a union with `kind`; add `actions` to `MakeRendererOptions`; extend `makeRenderer` to switch on kind; add `contentType` to meta envelope
- `runtime/islands/build.ts` — no change (uses existing per-island Bun.build pipeline)
- `example/hello-world/island.config.ts` — register `NoteForm`, `WhoAmI` islands
- `example/hello-world/index.ts` — call `brust.registerActions(...)`; pass `actions` to `makeRenderer`
- `example/hello-world/routes.tsx` — add `/note` and `/whoami` routes that mount the new islands
- `src/lib.rs` — new napi method `register_actions(ids: Vec<String>)`; new `ActionRegistry` (HashSet<String>) in State
- `src/server.rs` — handle `POST /_brust/action/<id>` before route-table lookup; method/length/charset/registry checks; build ActionEnvelope; reuse worker dispatch
- `src/routes.rs` — extend `RouteEnvelope` → `RouteEnvelope` union (`render` vs `action`); JSON serialisation
- `src/http.rs` — `build_response` accepts optional `content_type` override from meta (defaults to current `text/html; charset=utf-8`)

### Tests

- `src/server.rs`, `src/routes.rs` — inline `#[cfg(test)]` unit tests added
- `tests/integration.test.ts` — append new action-related tests (target ~10 new tests)

### Docs

- `architecture.md` — move "Server functions" entry in "Designed not built" list to "Built". Document the MVP scope simplifications inline (manual `registerActions`, no `"use server"` transform, JSON-only). Mirror the pattern used by the Islands MVP entry.

---

## 10. Risks & open questions

1. **Renderer tsfn now does two things.** Conflates render and RPC paths inside one entry. Mitigation: clean `switch (envelope.kind)` at the top of the JS dispatcher; separate terminal step per kind. If the conflation later hurts (separate metrics, separate logging contexts), a future plan splits into a second tsfn variant.

2. **Content-Type override via meta.contentType is a wire change.** Old Rust binary against new JS would see an unknown meta field. Mitigation: this MVP ships both sides together; the SAB format already tolerates unknown meta fields (Rust ignores extras via serde default). Unit test confirms backward-compat.

3. **`runtime/client` adds ~1 KB to every island chunk that uses it.** Each island bundle re-bundles the helper. Acceptable for MVP (islands are typically a few KB anyway). Shared chunk is a follow-up optimisation.

4. **Action id collisions.** Throws at `registerActions` time, not at build time. A developer who renames one action without checking client-side stubs sees a runtime 404, not a type error. Mitigation: `BrustActionError.status === 404` test is part of the example integration test. Real fix waits for `"use server"` codegen.

5. **Args JSON parsing happens at JS side.** Rust ships raw UTF-8 body. Malformed JSON → JS throws → 500 (caught by makeRenderer outer try) — should be 400. **Fix:** JS validates with `try { const parsed = JSON.parse(args_json); if (!Array.isArray(parsed)) return badArgs(); ... } catch { return { status: 400, body: '{"error":{"message":"invalid args JSON"}}' } }` at the head of the action branch, BEFORE middleware runs.

6. **Body size limit is the SAB cap (256 KB default).** Same limit as render output. Larger action payloads (uploads) require the multipart path — explicitly out of scope.

7. **No retries.** A worker that crashes mid-action loses the call (same as render path today). The "Retry on tsfn failure" follow-up addresses both paths together.

---

*End of design.*
