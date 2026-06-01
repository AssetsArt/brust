# MCP-over-EndpointDef — Design

Date: 2026-06-01
Status: Draft (brainstorm done), pending spec review
Supersedes: the stubbed MCP path that ships an empty `tools/list`
(`runtime/mcp/server.ts` `LegacyActionDef` + `actions: []`,
`runtime/mcp/extractor.ts` `'use server'`-derived tool extraction).
Builds on: `2026-06-01-actions-treaty-client-design.md` (the `defineActions`
/ `EndpointDef` / treaty system).

## Goal

Re-derive MCP tools from the `defineActions()` endpoint tree so that an MCP
client (Claude Desktop, etc.) sees one tool per HTTP endpoint, with a rich
JSON-Schema `inputSchema` inferred from the endpoint's `body`/`query` Standard
Schema and `{param}` path segments, and can invoke it via `tools/call` — going
through the *exact same* validation + middleware + handler path as a real HTTP
request.

Concretely:

- `tools/list` returns a tool per `EndpointDef` (`method` + `path`), with
  `inputSchema` built at **build time** via the TypeScript compiler API,
  persisted in `.brust/mcp-manifest.json` (the existing manifest architecture).
- `tools/call { name, arguments }` resolves the tool → `EndpointDef`, builds a
  synthetic action `RouteCall`, and dispatches through the existing
  `dispatchAction(call, byId)` — single source of truth for validation,
  middleware, and the handler `respond`/error contract.
- The `LegacyActionDef` stub and the `actions: []` placeholders are removed.

This is follow-up #1 from the treaty handoff ("MCP-over-EndpointDef rework").

## Non-goals (explicit)

- **NOT a runtime Standard-Schema→JSON-Schema converter.** Standard Schema v1
  exposes no JSON-Schema surface; we keep deriving schema from TS types at build
  time (consistent with how resources are already extracted, and with the old
  tool extractor). No new runtime dependency on Zod internals.
- **NOT a flat `arguments` shape.** `arguments` is **nested** by routing role:
  `{ params?, query?, body? }`. See §"inputSchema shape" for the rationale and
  the deferred flat-flattening follow-up.
- **NOT per-endpoint MCP opt-out / rename in v1.** Every registered endpoint
  becomes a tool (matches the old behavior: every `'use server'` action was a
  tool). `opts.description` is the only tool-metadata knob. `opts.mcp:false`
  opt-out and custom tool names are a documented follow-up.
- **NOT MCP resources rework.** `resources/list` + `resources/read` are derived
  from page-route loaders and are unchanged.
- **NOT streaming / SSE tool results.** `tools/call` stays single-response JSON,
  reusing `dispatchAction`'s single-chunk contract.
- **NOT output-schema validation.** `outputSchema` is type-derived metadata
  only (same posture as the resource/old-tool path); no runtime check.

## High-level architecture

```
 BUILD TIME (compiler API)                         RUNTIME (worker)
 ┌───────────────────────────┐                     ┌──────────────────────────┐
 │ actions.ts source          │                     │ EndpointDef[] (real fns + │
 │  defineActions()           │                     │  Standard Schema objects) │
 │    .post('/notes', h, {body})                    │                          │
 │    .get('/notes/{id}', h, {query})               │  makeMcpServer({manifest, │
 └─────────────┬─────────────┘                     │    endpoints, routes})    │
   walk chain  │ extractMcpManifest                 └──────────┬───────────────┘
   per call:   ▼                                               │ tools/call
   method, path, inputSchema (params from path,                ▼
   body/query from inferred handler-ctx types),     find tool→EndpointDef (method+path)
   outputSchema, description                         build synthetic action RouteCall
               │                                     ┌──────────┴───────────────┐
               ▼                                     │ dispatchAction(call,byId) │ ← SHARED
   .brust/mcp-manifest.json {tools[],resources[]}    │  validate→middleware→handler
               │  read by worker + prebuilt dist     └──────────┬───────────────┘
               ▼                                                ▼
   tools/list ◄── manifest.tools                     JSON-RPC result {content:[{type:text}]}
```

Two independently testable pieces:

1. **Extraction** (`runtime/mcp/extractor.ts`) — walk the `defineActions()`
   method chain in the actions source file; emit one `ToolSchema` per call.
2. **Dispatch** (`runtime/mcp/server.ts`) — `tools/list` from manifest;
   `tools/call` via a synthetic `RouteCall` through `dispatchAction`.

## API / data-shape surface

### `ToolSchema` (manifest) — changed

`runtime/mcp/manifest.ts`. Replace `paramOrder: string[]` (the old
positional-args mapping) with the routing identity:

```ts
export interface ToolSchema {
  name: string                 // derived, MCP-valid: see §"Tool naming"
  description?: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'  // NEW
  path: string                 // NEW — literal registered path, e.g. /notes/{id}
  inputSchema: JsonSchema
  outputSchema?: JsonSchema
}
```

`McpManifest.version` stays `1` (the file is regenerated on every build/boot;
it is not a persisted cross-version contract — `readManifest` rejects any other
version, so a stale shape can never be silently consumed). Resources unchanged.

### Tool naming

Deterministic slug, MCP-valid (`^[a-zA-Z0-9_-]+$`):

`<method-lowercase> + '_' + <path slug>` where the path slug is the path with
leading `/` stripped, `/` → `_`, and each `{x}` segment → `by_<x>`
(`{*rest}` → `by_rest`).

| method + path        | tool name             |
|----------------------|-----------------------|
| `POST /notes`        | `post_notes`          |
| `GET /notes/{id}`    | `get_notes_by_id`     |
| `DELETE /notes/{id}` | `delete_notes_by_id`  |
| `GET /whoami`        | `get_whoami`          |

Collision handling: the slug is many-to-one in pathological cases
(`/notes/{id}` and `/notes/by/id` both → `notes_by_id`). The extractor keeps a
`Set` of emitted names and **throws** at extraction on a duplicate, naming both
endpoints. (Build/boot fails loudly rather than silently dropping a tool.)

### `inputSchema` shape

Nested object by routing role; a sub-object is present **only if non-empty**:

```jsonc
{ "type": "object", "properties": {
    "params": { "type":"object", "properties": { "id": {"type":"string"} }, "required":["id"] },
    "query":  { /* from opts.query schema, inferred */ },
    "body":   { /* from opts.body schema, inferred */ }
} }
```

- **`params`**: built directly from the path's `{x}` segments (each a required
  `string`). Path-parse, NOT type-extraction — params are always string-valued
  and the type machinery's `Params<P>` would otherwise be re-derived. `{*rest}`
  → property `rest` (string). Omitted entirely when the path has no params.
- **`body`**: present iff the call's `opts` literal has a `body:` key. Schema
  from the inferred type of the handler ctx's `body` binding (resolves the
  Standard Schema `InferOutput`) via `tsTypeToJsonSchema`. GET/HEAD never carry
  body (no `body` key expected).
- **`query`**: present iff the call's `opts` literal has a `query:` key. Schema
  from the inferred type of the handler ctx's `query` binding.

Rationale for nesting over flat: `params`/`query`/`body` have distinct routing
destinations and can carry colliding field names; nesting is unambiguous and
maps mechanically to the dispatch envelope. Flat-flattening (better LLM
ergonomics, ambiguous on collision) is a documented follow-up.

If all three are empty → `{ "type":"object", "properties":{} }` (a no-arg tool,
e.g. `get_whoami`).

### `tools/call` dispatch

`runtime/mcp/server.ts` `handleToolsCall`:

1. Resolve `params.name` → `ToolSchema` (from manifest). Unknown → JSON-RPC
   `-32601`.
2. Resolve `ToolSchema.{method,path}` → `EndpointDef` from a
   `Map<string, EndpointDef>` keyed `"<METHOD> <path>"` built once in
   `makeMcpServer` from `opts.endpoints`. Missing (manifest/endpoints drift) →
   `-32603`.
3. Build a synthetic action `RouteCall`:
   ```ts
   const args = (rpc.params.arguments ?? {}) as { params?; query?; body? }
   const call = {
     kind: 'action',
     action_id: `${def.method} ${def.path}`,   // matches the byId key below
     req: { ...mcpReq, search: (args.query ?? {}) as Record<string,string> },
     params: (args.params ?? {}) as Record<string,string>,
     body_text: args.body === undefined ? '' : JSON.stringify(args.body),
     content_type: 'application/json',
   }
   ```
   and call `dispatchAction(call, byId)` where `byId` is the `"<METHOD> <path>"`
   map. `dispatchAction` keys lookup off `call.action_id`, so the synthetic key
   resolves the same def. This reuses validation (422), middleware (incl.
   short-circuit), the `respond` sentinel, and the 500 error contract verbatim.
4. Map the `BranchResponse` to a JSON-RPC tool result:
   - `status < 400` → `{ content:[{type:'text', text: body}], isError:false }`
   - `status >= 400` → `{ content:[{type:'text', text: body}], isError:true }`
   (preserves the old tools/call result contract — see existing lines 154-163.)

`dispatchAction` is exported from `runtime/routes.ts` already; `composeChain` is
dynamically imported there. The MCP server imports `dispatchAction` (static or
dynamic — match the file's existing style).

### `makeMcpServer` opts — changed

```ts
export interface McpServerOptions {
  manifest: McpManifest
  endpoints: EndpointDef[]     // was: actions: LegacyActionDef[]
  routes: FlatRoute[]
  packageVersion?: string
}
```

`LegacyActionDef` is **removed** from `server.ts`. `byId` is built in
`makeMcpServer` from `endpoints` keyed `"<METHOD> <path>"`.

### `extractMcpManifest` opts — changed

`runtime/mcp/extractor.ts`:

```ts
export interface ExtractOptions {
  actionsFile?: string         // was: serverFiles: string[] + actions: LegacyActionDef[]
  routesFile: string
  sourceRoots: string[]
  routes: FlatRoute[]
}
```

- `serverFiles` and `actions` are **removed**.
- `actionsFile` is the path to the module exporting `defineActions(...)`.
  Convention `<scanRoot>/actions.ts`; absent file → zero tools (resources still
  extracted). The compiler `Program` `rootNames` includes `actionsFile` (when
  present) + `routesFile` so the checker resolves the Standard-Schema-inferred
  body/query types and the handler ctx types.

### Callers — changed

- `runtime/index.ts buildMcpManifest`: opts lose `serverFiles`/`actions`, gain
  `actionsFile?`. `run()` main branch passes
  `actionsFile: existsSync(join(scanRoot,'actions.ts')) ? that : undefined`.
- `runtime/index.ts` worker branch: `makeMcpServer({ manifest, endpoints,
  routes: workerRoutes })` — `endpoints` is already in scope (line ~314).
- `runtime/cli/build.ts`: `extractMcpManifest({ actionsFile: existsSync(
  join(entryDir,'actions.ts')) ? that : undefined, routesFile, sourceRoots,
  routes })`.

## Extraction algorithm (compiler API)

In `extractMcpManifest`, when `actionsFile` is set and present:

1. `program.getSourceFile(actionsFile)`; for each top-level statement, find the
   exported `actions` initializer that is a `defineActions()` method chain
   (a `CallExpression` whose innermost receiver is a call to `defineActions`).
   Be tolerant: locate **any** chain whose base call's callee identifier text is
   `defineActions`. (`.use(...)` links are skipped — they carry no endpoint.)
2. Walk the chain outermost→inward collecting each `CallExpression` whose
   `expression` is a `PropertyAccessExpression`; reverse to registration order.
3. For each call where the property name ∈
   `{get,post,put,patch,delete,head}` (case-insensitive → upper method):
   - `path` = `args[0]` string-literal text. If not a string literal, **skip**
     with a `console.warn` (dynamic paths can't be statically extracted — be
     loud, don't silently emit a broken tool).
   - `params` schema: parse `path` for `{x}` / `{*x}` segments.
   - handler = `args[1]`; `opts` = `args[2]` (object literal, optional).
   - `body`/`query` presence: from `opts` having a `body`/`query` property
     assignment. If present, get the inferred type of the handler ctx's
     corresponding binding:
     - `checker.getTypeAtLocation(handler)` → call signature → first param type
       (the `ActionContext<…>`). `getProperty('body')` /`'query'` →
       `getTypeOfSymbolAtLocation` → `tsTypeToJsonSchema(t, {checker})`.
   - `outputSchema`: handler return type. From the call signature's return type,
     `tsTypeToJsonSchema(ret, {checker, unwrapPromise:true})`.
   - `description`: `opts.description` string-literal text, else undefined.
   - `name`: derived slug; throw on duplicate.
4. Sort tools by `name` (stable manifest), as today.

`head` is included in the extractor method set as forward-compat: the
`EndpointDef.method` *type* includes `'HEAD'`, but **no `.head` builder method
exists yet** (`ActionsBuilder`/`defineActions()` only expose
get/post/put/patch/delete). So in practice no `head` tool is emitted today; the
branch is harmless and ready for when `.head` lands.

Note: `tsTypeToJsonSchema` already handles object property enumeration, unions,
arrays, Date, literals — no converter changes expected. If the inferred `body`
type is `unknown` (no schema after all), it returns `{}` (loose) — acceptable.

## Behavior / invariants

- **Single dispatch path.** `tools/call` MUST route through `dispatchAction`.
  No second copy of validation/middleware/handler logic. A 422 from body
  validation surfaces as `isError:true` with the validator issues in `text`.
- **No HTTP round-trip.** `tools/call` builds the envelope in-process and calls
  `dispatchAction` directly (the MCP request already arrived over HTTP at
  `/_brust/mcp`); it does NOT re-issue a loopback fetch to `<actionPrefix>/…`.
- **`req` identity for middleware.** The synthetic call's `req` is the real
  incoming MCP `BrustRequest` (cookies/headers/signal) with `search` overridden
  from `arguments.query`. Middleware that reads cookies (e.g. `requireUser`)
  sees the MCP caller's cookies — same as the old path (which passed `req`
  through `composeChain`).
- **Manifest/endpoints alignment.** Tools come from the manifest (build time);
  dispatch endpoints come from the live `defineActions` (runtime). They are the
  same source (`actions.ts`) built two ways. A drift (tool present, endpoint
  missing) yields `-32603` at call time — never a silent wrong dispatch. The
  `"<METHOD> <path>"` key is the contract joining them.
- **Determinism.** Tool order is name-sorted; extraction order doesn't matter.
  Duplicate tool names throw at extraction (build/boot fails, not runtime).
- **GET/HEAD tools.** No `body` sub-schema; `arguments` may still carry
  `params`/`query`. Dispatch sets `body_text:''` so `dispatchAction`'s GET/HEAD
  branch skips body decode.

## File structure

Changed:
- `runtime/mcp/manifest.ts` — `ToolSchema`: drop `paramOrder`, add
  `method`+`path`.
- `runtime/mcp/extractor.ts` — drop `LegacyActionDef` import + `serverFiles`
  /`actions`; add `actionsFile`; replace `extractToolFromNode`/
  `toolFromSignature` with the chain-walk extractor + tool-naming + params-
  from-path; keep `extractResources` untouched.
- `runtime/mcp/server.ts` — remove `LegacyActionDef`; `McpServerOptions.actions`
  → `endpoints: EndpointDef[]`; rewrite `handleToolsCall` to dispatch via
  `dispatchAction`; build `byId` in `makeMcpServer`.
- `runtime/index.ts` — `buildMcpManifest` opts (incl. removing the
  `LegacyActionDef` reference in the opts type at ~line 220); `run()` main +
  worker wiring (`actionsFile`, `endpoints` into `makeMcpServer`).
- `runtime/mcp/manifest.test.ts` — the `ToolSchema` literal (~line 15) builds
  `paramOrder: []` with no `method`/`path`; update it to the new shape (it is
  the only other `ToolSchema` literal in the tree).
- `runtime/cli/build.ts` — `extractMcpManifest` call args.
- `runtime/define-actions.ts` — add `description?: string` to `EndpointOptions`
  (build-time-read metadata; runtime-harmless).
- `tests/integration.test.ts` — replace the "tools/list is empty" test with
  real tool assertions + a `tools/call` round-trip (see §Tests).

New:
- `runtime/mcp/extractor.test.ts` cases (or extend existing) for the chain walk,
  tool naming, params-from-path, body/query inference, duplicate-name throw.

Removed:
- `LegacyActionDef` interface (`server.ts`) and its `extractor.ts` import.
- `extractToolFromNode` / `toolFromSignature` (positional-args extraction).

## Tests / acceptance criteria

Unit (Bun, `runtime/mcp/*.test.ts`):
- **Extractor chain walk**: a fixture actions source (`defineActions().post(
  '/notes', h, {body:z…}).get('/notes/{id}', h, {query:z…}).get('/whoami', h)`)
  → tools `[get_notes_by_id, get_whoami, post_notes]` (name-sorted), each with
  correct `method`, `path`.
- **inputSchema**: `post_notes` → `{properties:{body:{properties:{text:
  {type:string}}…}}}`; `get_notes_by_id` → `params.id` required string +
  `query` from schema; `get_whoami` → `{properties:{}}`.
- **Tool naming** table (incl. `{*rest}` → `by_rest`).
- **Duplicate name throws.**
- **Dynamic (non-literal) path** → skipped with warn, not emitted.
- **Server `tools/list`**: returns name+description+inputSchema+outputSchema
  for a manifest.
- **Server `tools/call`**: with a stub `endpoints` + `dispatchAction` reuse —
  success (`isError:false`, text = handler JSON), validation-fail
  (`isError:true`, 422 issues in text), unknown tool (`-32601`), tool present
  but endpoint missing (`-32603`).

Integration (real addon + server, `tests/integration.test.ts`):
- `tools/list` returns the fixture's tools (post_notes, get_whoami,
  delete_notes_by_id, get_last_sse_abort, get_last_ws_close) — name-sorted,
  with `post_notes.inputSchema.properties.body` present.
- `tools/call post_notes {body:{text:'hi'}}` → `isError:false`, text parses to
  `{id:'n-2'}` (fixture handler: `'n-' + body.text.length`).
- `tools/call post_notes {body:{}}` (missing text) → `isError:true` (422 body
  validation).
- `tools/call delete_notes_by_id {params:{id:'x'}}` WITHOUT the `user` cookie →
  `isError:true` (middleware `requireUser` 401 short-circuit); WITH cookie →
  `isError:false`. (Proves middleware + params flow through dispatch.)

Baselines that must stay green (project gates):
- `cargo fmt --check`, `cargo clippy --all-targets --locked -D warnings`,
  `cargo test -p brust` (Rust untouched here — should be a no-op, confirm).
- `bunx biome ci .` (TS lint gate — run after every `.ts` edit).
- `bun test runtime/`, `tests/treaty-integration.test.ts`,
  `tests/integration.test.ts`, native-island{,-ssr}.
- `cli-build.test.ts /native-islands` failure is pre-existing (out of gate).

## Phasing (be loud)

- **Phase 1 — manifest + extraction**: `ToolSchema` shape, chain-walk extractor,
  tool naming, params-from-path, body/query inference, extractor unit tests +
  `extractMcpManifest`/`buildMcpManifest`/`build.ts` opts. Green: extractor
  units + biome.
- **Phase 2 — server dispatch**: `McpServerOptions.endpoints`, `handleToolsCall`
  via `dispatchAction`, `byId`, remove `LegacyActionDef`. Green: server units +
  biome.
- **Phase 3 — wiring + integration**: `index.ts` main/worker wiring; rewrite the
  integration `tools/list`/`tools/call` tests; `EndpointOptions.description`.
  Green: full integration suite.

A vertical slice through 1+2+3 for `post_notes` (body) + `get_whoami` (no args)
+ `delete_notes_by_id` (params + middleware) is the minimum demonstrating the
design end-to-end and is the priority if the run is truncated.

## Known limitations / deferred

- **No `opts.mcp:false` opt-out / custom tool name.** All endpoints are tools;
  rename/exclude is a follow-up. Test-probe endpoints (`/last-sse-abort`,
  `/last-ws-close`) will appear as tools — harmless.
- **Nested `arguments` only.** No flat-flattening; documented above.
- **Static-literal paths only.** Endpoints registered with a computed path
  string are skipped from MCP (warned), though they still serve over HTTP.
- **Build-time schema = best-effort.** Exotic inferred types fall back to `{}`
  (loose) via `tsTypeToJsonSchema`; runtime validation (the real `body`/`query`
  Standard Schema) is unaffected and still enforced on `tools/call`.
- **No output-schema runtime validation** (metadata only).

## Resolved (spec review)

1. **Import of `dispatchAction`**: **static** `import { dispatchAction } from
   '../routes.ts'` in `server.ts` is safe — no runtime cycle. `routes.ts`
   imports `mcp/server.ts` only as erased `import type`; `server.ts` imports
   `routes.ts` only as `import type` today. The existing dynamic
   `import('../routes.ts')` for `composeChain` (`server.ts:134`) is removed with
   the old `handleToolsCall`.
2. **Fixture wiring**: `tests/fixtures/app/index.ts` already calls
   `brust.run({ routes, entry, actions })`, so worker `endpoints` is non-empty.
   No extra wiring. Fixture handler `'n-' + body.text.length` ⇒ `{text:'hi'}` →
   `'n-2'` (acceptance claim correct). Probe paths `/last-sse-abort` /
   `/last-ws-close` ⇒ tools `get_last_sse_abort` / `get_last_ws_close`.
3. **Spread `req`**: safe. `call.req` is a plain `JSON.parse`'d object
   (`routes.ts:525`) — own enumerable data props + assigned `.signal`, no
   getters/class. `{ ...mcpReq, search }` preserves cookies/headers for
   `requireUser`.
</content>
</invoke>
