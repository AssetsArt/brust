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
  }
  ```
  Handler returns `R | Promise<R>`. `R` is the inferred output type. Returning a
  plain value → `200 application/json`. To control status/headers a handler may
  return a `RouteResponse` sentinel via `ctx.respond(...)` (see §4).
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
- Registry key (action_id): `"<METHOD> <endpoint-path>"`, e.g. `"GET /notes/{id}"`.
  Stays within the existing `is_safe_action_id`-style charset rules **after**
  relaxing them to permit `/`, `{`, `}`, `*`, space, and uppercase method —
  validated by a new `is_safe_endpoint_key`.
- Envelope (`kind: "action"`) gains `params: Record<string,string>` (extracted by
  Rust's matchit) and keeps `method`, `req` (which already carries query). Body
  fields unchanged (`body_text` / `body_b64` / `content_type`).
- Response: single-chunk JSON. Validation failure → `422` with
  `{ error: { message, issues } }` (issues = Standard Schema issue array).

## Behavior / invariants

- **Validation runs in the worker (JS), before the handler, after middleware
  body-independent checks.** Order: decode body → run `opts.body` validate →
  run `opts.query` validate → build context → middleware chain → handler. A
  validation failure short-circuits to 422 without invoking the handler.
- **Rust never validates** — it only matches method+path, extracts params, and
  ships bytes. Keeps the hot path lock-free / single-chunk.
- **Method gate**: the outer gate in `server.rs` is generalized — any method is
  legal under `<actionPrefix>/`; everything outside stays GET-only (page routes)
  except the existing `/_brust/cache/invalidate` and `/_brust/mcp` POST cases.
- **GET/HEAD with no body**: the body-read path must tolerate absent
  Content-Length (no 411 for methods that carry no body).
- **404 vs 405**: unknown path under prefix → 404. Known path, wrong method →
  405 (matchit match succeeds for path but no registry entry for that method).
- **Determinism**: registration order does not affect matching (matchit is a
  radix tree); duplicate `"<METHOD> <path>"` keys throw at registration.

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

## Open questions resolved at plan time

- Exact `ctx.respond()` sentinel vs returning a `RouteResponse` directly — pick
  one in the plan; lean `return ctx.respond(body, { status, headers })` to keep
  the common `return value` path clean.
- Whether `head` auto-derives from a `get` endpoint or must be declared — lean
  "must be declared" for v1 (simpler registry), revisit later.
