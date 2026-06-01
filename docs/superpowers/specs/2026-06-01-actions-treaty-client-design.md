# Actions → Treaty Client (Eden-style typed RPC) — Design

Date: 2026-06-01
Status: Approved (brainstorm), pending implementation
Supersedes: the `'use server'` file scanner + `action('id')` / `formAction('id')`
client stubs (`runtime/scan-actions.ts`, the `action`/`formAction` helpers in
`runtime/client/index.ts`).

## Goal

Replace brust's string-id RPC actions with an **Eden-Treaty-style, end-to-end
type-safe client** derived purely from server types (no codegen):

- A **chained builder** (`defineActions()`) declares typed endpoints carrying
  `method + path + input/output schema`. `typeof actions` is the single type the
  client infers from.
- A **proxy client** (`client<Actions>()`) mirrors the endpoint tree:
  path → object, `{param}` → callable, method → terminal call. Returns an
  Eden-style `{ data, error, status, headers, response }` — never throws on HTTP
  error.
- **All HTTP methods** supported (GET/POST/PUT/PATCH/DELETE/HEAD), not POST-only.
- The action mount **prefix is configurable** via `brust.run({ actionPrefix })`
  (default `/_brust/action`), and propagated to the browser client.
- Input validation via **Standard Schema** (Zod 3.24+/Valibot/ArkType/any
  conforming validator) — runtime validation AND type inference from one schema.

This is the "client RPC auto-rewrite" follow-up named in the project handoff,
done as a typed proxy instead of a compiler rewrite.

## Non-goals (explicit)

- **NOT a full REST router replacing page routes.** Page routes (`defineRoutes`,
  React/native/sse/ws) are unchanged. Actions remain namespaced under
  `actionPrefix`; they do not mount at `/`.
- **NOT GraphQL / OpenAPI generation.** No schema export surface beyond the TS
  types in this iteration.
- **NOT WebSocket-over-treaty.** Eden Treaty has a `.subscribe()` WS surface;
  brust keeps WebSockets on the existing `websocket:` route field. Out of scope.
- **NOT streaming responses from actions.** Actions stay single-chunk
  (`dispatch_single_chunk`). SSE stays on the `sse:` route field.
- **NOT per-call auth/session middleware redesign.** The existing `Middleware`
  contract is reused; only its *invocation context* changes (see §4).

## High-level architecture

```
 server (defineActions)            wire                         client (client<A>())
 ┌────────────────────┐                                       ┌────────────────────┐
 │ .post('/notes',fn, │   register: ["POST /notes", ...]      │  Proxy records      │
 │   {body: Schema})  │ ───────────────────────────────────► │  segments + method  │
 │ typeof actions = A │                                       │  → builds URL+fetch │
 └─────────┬──────────┘                                       └─────────┬──────────┘
           │ EndpointDef[]                                              │ HTTP
           ▼                                                            ▼
   Rust registry (matchit per method)  ◄──── METHOD <prefix>/<path>?<query> ────
           │ envelope {method,path,params,query,body}
           ▼
   worker dispatch → validate (Standard Schema) → handler({req,body,params,query,headers})
           │ result → JSON                       ▲ 422 on validation failure
           ▼
   single-chunk response  ──────────────────────► { data | error, status, headers }
```

Three subsystems, each independently testable:

1. **Rust wire** (`crates/brust/src/{server,routes,lib}.rs`) — transport only.
   Method-aware matchit router for the action subtree, param extraction, query
   passthrough, body read for all methods, configurable prefix. Stays "dumb":
   no validation, no knowledge of schemas.
2. **Server builder + dispatch** (`runtime/define-actions.ts`,
   `runtime/actions.ts`, `runtime/routes.ts` action branch) — the chained
   builder, the accumulated type, the registry shape, Standard Schema validation,
   and the handler-context dispatch.
3. **Client proxy** (`runtime/client/index.ts`) — the treaty Proxy, the
   recursive tree type derived from `Actions`, the `{data,error}` response,
   prefix propagation.

## API surface

### Server — `defineActions()`

```ts
import { defineActions } from 'brust'
import { z } from 'zod'

export const actions = defineActions()
  .use(authMiddleware)                                  // global middleware
  .post('/notes', ({ req, body }) => ({ id: 'n-1' }), {
    body: z.object({ text: z.string().max(1000) }),
  })
  .get('/notes/{id}', ({ params, query }) => db.note(params.id), {
    query: z.object({ verbose: z.coerce.boolean().optional() }),
  })
  .delete('/notes/{id}', ({ params }) => db.del(params.id), {
    middleware: [requireUser],                          // per-endpoint middleware
  })

export type Actions = typeof actions
```

- **Methods**: `.get .post .put .patch .delete .head`. Signature:
  `(path: string, handler: Handler, opts?: EndpointOptions)`.
- **Path**: matchit syntax, param as `{id}` (matches brust's existing
  `/blog/{slug}` page-route convention). Catch-all `{*rest}` allowed (matchit).
- **Handler context** (single object arg):
  ```ts
  interface ActionContext<Body, Params, Query> {
    req: BrustRequest          // existing type: method, headers, cookies, signal
    body: Body                 // validated+typed when opts.body set; else unknown
    params: Params             // typed from path's {param} segments (string-valued)
    query: Query               // validated+typed when opts.query set; else Record<string,string>
    headers: Record<string,string>
    /** Branded response sentinel. Returning ctx.respond(...) controls
     * status/headers; returning any other value ships it as 200 JSON. */
    respond: (body: unknown, init?: { status?: number; headers?: Record<string,string> }) => ActionResponseSentinel
  }
  ```
  Handler returns `R | Promise<R>` (plain value → `200 application/json`) **or**
  `ctx.respond(...)` to set status/headers. The dispatcher detects a respond
  return by a **branded private symbol** (identity check), NOT by duck-typing a
  `{status, body}` shape — otherwise a user payload that happens to contain a
  `status` field would be misread as a response envelope. `ctx.respond` is the
  single sanctioned status-control path (resolves the §"Open questions" fork).
- **`opts: EndpointOptions`**:
  ```ts
  interface EndpointOptions {
    body?: StandardSchemaV1       // validates request body (non-GET/HEAD)
    query?: StandardSchemaV1      // validates parsed query string
    middleware?: Middleware[]     // per-endpoint, appended after global .use()
  }
  ```
- **`.use(mw)`**: appends a global middleware run before every endpoint's own
  middleware (parent-before-child, same ordering rule as routes).
- **Accumulated type**: each builder method returns
  `ActionsBuilder<Acc & Record<Path, Record<Method, EndpointType>>>` where
  `EndpointType = { input: <body|query|params>, output: <R> }`. `typeof actions`
  therefore carries the full `{ path: { METHOD: {input, output} } }` map. This is
  the load-bearing type-machinery (mirrors how Elysia/Eden accumulate `App`).

### Client — `client<Actions>()`

```ts
import { client } from 'brust/client'
import type { Actions } from '../actions'

const api = client<Actions>()                 // prefix auto from injected global
// or: client<Actions>({ prefix: '/api', fetch, headers })

await api.notes.post({ text: 'hi' })                       // POST   <prefix>/notes
await api.notes({ id }).get({ query: { verbose: true } })  // GET    <prefix>/notes/{id}
const { data, error, status } = await api.notes({ id }).delete()
```

- **Path mapping**: object key per static segment (`api.notes.sub` →
  `/notes/sub`); a `{param}` segment becomes a **callable** that takes the param
  value(s): `api.notes({ id }).get()`. Multiple params chain.
- **Method terminal**: `.get .post .put .patch .delete .head`. Argument shape
  mirrors Eden:
  - GET/HEAD: `(options?)` where `options = { query?, headers?, fetch? }`.
  - POST/PUT/PATCH/DELETE: `(body?, options?)`.
- **Response** (resolves, never rejects on HTTP status):
  ```ts
  interface TreatyResponse<Data, Err> {
    data: Data | null          // non-null on 2xx
    error: { status: number; value: Err } | null   // non-null on >=300
    status: number
    headers: Record<string, string>
    response: Response         // raw web Response
  }
  ```
  Network/abort failures resolve as `error: { status: 0, value: <Error> }` (NOT a
  throw) so callers have one uniform branch. Type-narrowing by `error.status`
  works in a `switch` (Eden semantics).
- **Config** (`client<A>(opts?)`):
  ```ts
  interface ClientOptions {
    prefix?: string                          // default: injected global, else '/_brust/action'
    headers?: Record<string,string> | (() => Record<string,string>)
    fetch?: typeof fetch                     // override (tests / non-browser)
    onRequest?: (url: string, init: RequestInit) => void | RequestInit
    onResponse?: (res: Response) => void
  }
  ```

### Config — `brust.run({ actionPrefix })`

- New optional field on `brust.run` opts: `actionPrefix?: string`
  (default `/_brust/action`). Validated: must start with `/`, no trailing slash,
  no whitespace, not collide with reserved `/_brust/` internals other than the
  action root. Passed to Rust at `beginServe` and used as the matchit mount
  point. Also injected into rendered pages as
  `globalThis.__BRUST_ACTION_PREFIX__` (via the existing island-bootstrap
  injection path) so `client<A>()` needs no argument in the browser.

## Wire protocol

- Request: `METHOD <actionPrefix>/<endpoint-path>?<query>` with body for
  non-GET/HEAD. Content-Type drives body decode (existing logic): `application/json`
  (default), `application/x-www-form-urlencoded`, `multipart/form-data` (b64).
- **Action router data structure (resolves the 404-vs-405 problem).** A
  **path-only** `matchit::Router` whose value is a **per-path method table**
  `methods: SmallVec<(Method, EndpointId)>` (or `[Option<EndpointId>; N_METHODS]`).
  Dispatch (Phase A — **replaces** the literal `strip_prefix("/_brust/action/")`
  parse at `server.rs:313`):
  1. strip `<actionPrefix>` from the path → `rel`.
  2. `action_router.at(rel)`:
     - `Err(NotFound)` → **404** (unknown path).
     - `Ok(m)` → look up the request method in `m.value.methods`:
       - present → dispatch that `EndpointId`, harvest params from `m.params`.
       - absent → **405** (path exists, method not registered). *This is the
         distinction a single method-keyed tree cannot make — matchit bakes no
         per-path method set, so 405 requires this path-only-tree + method-table
         shape.*
  This means the registry is NOT keyed by a `"METHOD /path"` string; method is a
  separate enum dimension. Params come from `m.params` (matchit), NOT from any
  string parse.
- **Charset / validation of the path.** The old `is_safe_action_id`
  (`[A-Za-z0-9_-]+`) does not fit matchit paths. The endpoint *path* is validated
  by: TS-side `isValidEndpointPath` (must start `/`, no whitespace, no `?#`,
  non-empty) + matchit `insert()` rejecting malformed patterns at registration.
  Method is validated against the known method enum. **All four legacy
  enforcement sites must change together** (Blocker from spec review):
  1. `runtime/actions.ts::isValidActionId` (`/^[A-Za-z0-9_-]+$/`) — throws first
     in `registerActionsInternal`; **replace** with `isValidEndpointPath` + method check.
  2. `crates/brust/src/lib.rs::is_safe_action_id` — repurpose/remove.
  3. `crates/brust/src/server.rs::is_safe_action_id` — repurpose/remove.
  4. The Rust invariant test asserting the two helpers agree
     (`lib.rs::server_action_id_matches_lib_helper`) — update or delete.
- Envelope (`kind: "action"`) gains `params: Vec<(Cow<str>, &str)>` serialized as
  a map (mirroring `RouteEnvelope.params` at `routes.rs:41`, reusing
  `serialize_as_map`), harvested from the action-router `m.params`. Keeps
  `method`, `req` (query lives in `req`). Body fields unchanged
  (`body_text` / `body_b64` / `content_type`).
- **Duplicate / conflict detection at registration**: a pre-insert TS `Set` of
  `"<METHOD> <path>"` throws on exact duplicates with a clear message; matchit
  `insert()` additionally throws on structural conflicts (e.g. param-name
  conflict `{a}` vs `{b}` at the same position) — surface matchit's error verbatim
  prefixed with the offending pattern.
- Response: single-chunk JSON. Validation failure → `422` with
  `{ error: { message, issues } }` (issues = Standard Schema issue array).

## Behavior / invariants

- **Body shape for validation.** `ctx.body` is a parsed value, not an args array
  (the old args-array protocol is gone). For `application/json` (default),
  `body` = `JSON.parse(body_text)`. **Standard Schema validators operate on plain
  objects**, so in the first slice **validation is scoped to JSON bodies**.
  `application/x-www-form-urlencoded` and `multipart/form-data` decode to
  `FormData`; their coercion to a validatable object (`Object.fromEntries`, files
  excluded) is **Phase D** — until then a schema on a multipart endpoint is a
  type-only contract, not a runtime check. Be loud: the slice's "validated 422
  path" is JSON-only.
- **Validation runs in the worker (JS), before the handler.** Order: decode body
  → (JSON) run `opts.body` validate → run `opts.query` validate → build context →
  middleware chain → handler. A validation failure short-circuits to 422 without
  invoking the handler or middleware.
- **Rust never validates** — it only matches path, selects method, extracts
  params, and ships bytes. Keeps the hot path lock-free / single-chunk.
- **Method gate**: the outer gate in `server.rs` keys off the **runtime
  `actionPrefix`** (not the literal `/_brust/action/`): any method is legal when
  the path is under `<actionPrefix>/`; everything outside stays GET-only (page
  routes) except the existing `/_brust/cache/invalidate` and `/_brust/mcp` POST
  cases, which remain special-cased. The static `/_brust/islands`, `/css`,
  `/_brust/cache/stats` GET checks that precede the action branch are unaffected.
- **GET/HEAD with no body**: gate the existing 411 branch (`server.rs:342`) on
  method — for GET/HEAD an absent Content-Length means `content_length = 0`
  (empty body), do NOT 411, do NOT close the keep-alive connection. POST/PUT/PATCH
  with absent Content-Length still 411 (no silent body truncation).
- **404 vs 405**: see the action-router data structure in §Wire — path miss → 404,
  path hit with unregistered method → 405. Acceptance tests assert both.
- **Determinism**: registration order does not affect matching (matchit radix
  tree); duplicate `"<METHOD> <path>"` throws at registration (TS `Set` +
  matchit `InsertError`).

## File structure

New:
- `runtime/define-actions.ts` — `defineActions()` builder, `ActionsBuilder` type,
  `EndpointDef` runtime shape, accumulated-type machinery.
- `runtime/standard-schema.ts` — minimal Standard Schema v1 types + a
  `validate(schema, input)` helper (sync/async) returning `{ value } | { issues }`.
- `runtime/treaty.ts` (or extend `runtime/client/index.ts`) — the proxy + tree
  type + response shape.

Changed:
- `runtime/actions.ts` — `ActionDef` becomes `EndpointDef` (id = method+path key,
  carries `method`, `schemas`, `handler`, `middleware`). `withMiddleware` removed
  (middleware now declared in `opts`).
- `runtime/routes.ts` — `RouteCall` action variant + `actionBranchToResponse`
  rewritten for context-object handlers, params, query, validation.
- `runtime/index.ts` — `brust.run`/`serve` accept `actions` builder + `actionPrefix`;
  registration walks `actions.endpoints`. Remove `scanActions` auto-scan call.
- `runtime/client/index.ts` — remove `action`/`formAction`; export `client`.
- `crates/brust/src/server.rs` — method gate + prefix + matchit action router +
  params + body-for-all-methods.
- `crates/brust/src/routes.rs` — action matchit table + `params` in envelope +
  `is_safe_endpoint_key`.
- `crates/brust/src/lib.rs` — `register_actions(Vec<{method,path}>)` builds the
  action matchit table; `actionPrefix` plumbed through `beginServe`.

Removed:
- `runtime/scan-actions.ts` + `runtime/scan-actions.test.ts`
- `'use server'` directive handling.

## Migration (end state = full replace)

Sequencing to avoid a red suite mid-flight:

1. Build the new system **alongside** the old (new files, new Rust paths) with new
   tests proving it green end-to-end.
2. Port `tests/fixtures/app/actions.ts` + its island components
   (`NoteForm`/`WhoAmI`/`AvatarUpload`) and `example/hello-world` to
   `defineActions` + `client`.
3. Delete the old scanner, `action`/`formAction`, `withMiddleware`, and update all
   referencing tests.
4. Update `architecture.md` (actions section) + `bench/apps/brust/actions.ts`.

The end state is **replace** — no `'use server'`, no `action('id')`. Step 1's
transient coexistence is an implementation convenience, not a shipped dual API.

## Tests / acceptance criteria

Unit (Bun):
- `defineActions` accumulates endpoints; duplicate `METHOD path` throws; `.use`
  ordering; `EndpointDef` shape.
- Standard Schema validate helper: Zod object pass/fail → `{value}`/`{issues}`;
  async schema; non-conforming input.
- Treaty proxy (with injected `fetch`): URL composition for static + `{param}`
  paths; method→verb; GET options vs POST body+options; `{data,error,status}`
  on 2xx/4xx/5xx/network-fail; prefix override + global pickup.
- Type-level: `tsc` golden that `api.notes.post(...)` infers body/return; wrong
  body shape is a type error (a `// @ts-expect-error` fixture).

Integration (real addon, real server — mirrors existing
`tests/native-island*.test.ts` style):
- All methods round-trip: GET (query+params), POST (json body), PUT, PATCH,
  DELETE; 200 path + validated 422 path + 404 (unknown path) + 405 (wrong method).
- Configurable `actionPrefix` honored end-to-end (server mount + client global).
- Middleware: global `.use` + per-endpoint `middleware` run in order; short-circuit
  works.

Rust (`cargo test -p brust`):
- `is_safe_endpoint_key` accept/reject table.
- action matchit: method+path match, param extraction, 404/405 discrimination.

Baselines that must stay green (per project gates): `cargo fmt --check`,
`cargo clippy --all-targets --locked -D warnings`, `cargo test -p brust`, and the
CI bun-test steps (`runtime/`, `native-island{,-ssr}`, `cli-new`, `integration`).
`cli-build.test.ts` `/native-islands` failure is pre-existing (out of gate).

## Phasing (decomposition — be loud)

The whole design above is the contract. Implementation is sequenced; a single
autonomous run is unlikely to land all four phases green. Ship in this order,
report honestly what landed:

- **Phase A — Rust wire**: method gate, `actionPrefix`, action matchit router,
  param extraction, body for all methods, envelope `params`. Rust tests green.
- **Phase B — Server builder + dispatch**: `defineActions`, accumulated type,
  Standard Schema validate, context-object handler dispatch, registration.
  Unit + Rust-integration green.
- **Phase C — Client proxy**: `client<A>()`, tree type, `{data,error}`, prefix
  propagation. Unit + type-golden green.
- **Phase D — Migration + docs**: port fixtures/example/bench, delete old system,
  update `architecture.md`. Full suite green.

A vertical slice through A+B+C for GET+POST with body+params+validation is the
minimum that demonstrates the design end-to-end and is the priority if the run is
truncated; PUT/PATCH/DELETE/HEAD breadth, multipart, query-schema, and the full
Phase D migration are the documented follow-ups.

## Known limitations / deferred

- Type machinery targets faithful inference for the common cases (static + param
  paths, body/return, GET query). Exotic edges (deeply nested catch-alls,
  overloaded same-path multi-param) may fall back to looser types; runtime stays
  correct. Captured as a follow-up, not a blocker.
- Multipart/file upload through the proxy (Eden auto-sets multipart when a `File`
  is present) is Phase D+; the wire already supports multipart via the existing
  b64 path.
- No response-body schema validation (output is trusted from the handler);
  `opts.output` typing only, no runtime check. Matches Eden's default posture.
- Error `value` typing is best-effort (`unknown`-narrowed by status) unless a
  per-status error schema is later added.

## Resolved decisions (from spec review)

- **Status control**: branded `ctx.respond()` sentinel only (identity-checked).
  No duck-typing of `{status, body}`. (§API handler context.)
- **`head`**: must be declared explicitly for v1 (no auto-derive from `get`) —
  simpler method table.
- **404 vs 405**: path-only matchit tree + per-path method table (§Wire), NOT a
  method-keyed path string.
- **Charset**: all four legacy `is_safe_action_id` sites change together; the
  endpoint *path* is validated by `isValidEndpointPath` + matchit, method by enum.
- **Runtime URL invariant**: the client proxy composes the request URL from the
  **literal registered path string** (filling `{param}` from the param-call args),
  never from the inferred TS type. Type-level path parsing may loosen on exotic
  patterns (catch-all, multi-param) without affecting runtime correctness.
- **Validation scope (slice)**: JSON bodies only; FormData→object coercion for
  urlencoded/multipart is Phase D.
- **Prefix→gate plumbing**: the `server.rs` method gate keys off the runtime
  `actionPrefix`, preserving the `/_brust/cache/invalidate` + `/_brust/mcp` POST
  special-cases and the preceding static GET checks.
