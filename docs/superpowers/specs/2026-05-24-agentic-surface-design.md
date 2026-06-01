# Agentic Surface (MCP) — Design Spec

**Sub-project:** Tier-2 follow-up #5. Expose Brust's server actions, loaders, and routes as a Model Context Protocol (MCP) server so AI agents can discover and invoke them.
**Date:** 2026-05-24
**Status:** approved for implementation planning. Execution deferred to next session per length-of-session scope check.
**Parent design:** `architecture.md` S "Agentic surface"
**Related shipped:**
- `2026-05-24-server-functions-design.md` (action dispatch wire format — reused for `tools/call`)
- `2026-05-24-use-server-directive-design.md` (action discovery via `'use server'` files — reused for `tools/list`)
- `2026-05-24-forms-multipart-design.md` (orthogonal — multipart action calls still work)
- `2026-05-24-nested-routes-design.md` (FlatRoute chain — reused for loader discovery + URI templates)

---

## 1. Overview & Scope

### Goal

Mount a Model Context Protocol (MCP) server at `POST /_brust/mcp` that exposes:

- **tools** — every server action discovered by `brust.scanActions()`
- **resources** — every route loader (parametrised by the route's path → MCP URI template)
- **prompts** — empty list at MVP (capability declared for future user-supplied prompts)
- **logging** — accept `logging/setLevel`, route messages to existing tracing
- **roots** — declared but empty (Brust doesn't operate on filesystems)

Tool and resource schemas are extracted at boot via the TypeScript compiler API
walking the `'use server'` files + the route module, converted to JSON Schema,
and cached to `.brust/mcp-manifest.json`.

```tsx
// What an agent sees after `initialize`:
{
  protocolVersion: "2025-06-18",
  capabilities: { tools: {}, resources: {}, prompts: {}, logging: {}, roots: {} },
  serverInfo: { name: "brust", version: "0.1.0" }
}

// tools/list — driven by scanActions() + TS extractor
[
  {
    name: "createNote",
    description: "Insert a note and return its id.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  ...
]

// resources/list — driven by route loaders + URI templates
[
  { uri: "brust:///blog/{slug}", name: "blog post", mimeType: "application/json" },
  ...
]
```

### Success criterion

> An MCP client (e.g., `mcp-cli` or the inspector at `npm i @modelcontextprotocol/inspector`)
> connects to `http://127.0.0.1:38900/_brust/mcp`, completes the `initialize` handshake,
> lists 4+ tools (every action), and successfully invokes `tools/call` for `createNote('hello')`
> receiving `{ content: [{ type: "text", text: "{\"id\":\"n-...\"}" }], isError: false }`.
> The same client can list 1+ resources (the `/blog/{slug}` loader) and fetch
> `brust:///blog/hello-world` returning the loader's JSON output.

### Concrete acceptance

```bash
$ BRUST_PORT=38900 bun run example/hello-world/index.ts &
$ sleep 6
$ npx @modelcontextprotocol/inspector --cli http://127.0.0.1:38900/_brust/mcp

# initialize
$ curl -s -X POST -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}' \
  http://127.0.0.1:38900/_brust/mcp
# → {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{...},"serverInfo":{"name":"brust","version":"0.1.0"}}}

# tools/list (using the session header from initialize)
$ curl -s -X POST -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  http://127.0.0.1:38900/_brust/mcp
# → result.tools includes createNote, deleteNote, pingAction, uploadAvatar, whoAmI

# tools/call createNote
$ curl -s -X POST -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"createNote","arguments":{"text":"hello"}}}' \
  http://127.0.0.1:38900/_brust/mcp
# → result.content[0].text contains a valid {"id":"n-..."}

# resources/list
$ curl -s -X POST -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":4,"method":"resources/list"}' \
  http://127.0.0.1:38900/_brust/mcp
# → result.resources contains brust:///blog/{slug}

# resources/read
$ curl -s -X POST -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":5,"method":"resources/read","params":{"uri":"brust:///blog/hello"}}' \
  http://127.0.0.1:38900/_brust/mcp
# → result.contents[0].text contains the loader's JSON output

$ bun test
✓ 41 → 50+ integration tests pass (existing + 9 new MCP tests)

$ cargo test --lib
✓ 55 → 58+ Rust unit tests (added: MCP envelope, manifest serialise)
```

### MVP scope decisions (locked during brainstorm 2026-05-24)

| Decision | Choice | Rationale |
|---|---|---|
| Protocol | **MCP 2025-06-18** (latest stable) | Latest published rev; covers all needed capabilities. Older revs lack tool result content blocks. |
| Transport | **POST-only over `/_brust/mcp`** | Stateless request/response. SSE-leg (`GET /_brust/mcp`) deferred — Brust's worker pool isn't tuned for long-lived streams. POST-only is valid Streamable HTTP per spec. |
| Capabilities shipped | **tools + resources + prompts (empty) + logging + roots (empty)** | User-chosen full coverage. Empty prompts/roots = declare capability but always return `[]`. |
| Schema extraction | **TS compiler API at boot** | `typescript` dep added. Walks each `'use server'` source + route loader signatures. Converts inferred types → JSON Schema. |
| Schema cache | **`.brust/mcp-manifest.json`** | Written by main at boot; workers + MCP handler read it. Same shape as `scanActions` cache pattern. |
| Worker dispatch | **New envelope kind `"mcp"`** | Mirrors action envelope. Worker JSON-RPC handler reuses action dispatch for `tools/call`. |
| Authentication | **Per-tool middleware preserved** | `tools/call` runs the action's middleware chain — middleware-gated actions still 401 from inside MCP. |
| Session management | **Stateless (no Mcp-Session-Id)** | MCP allows stateless mode. Initialize returns capabilities + serverInfo; client doesn't need a session id for POST-only. |

### Out of scope (deferred)

1. **SSE leg (`GET /_brust/mcp`)** — needed for streaming notifications (`notifications/progress`, server-initiated `notifications/tools/list_changed`). Requires long-lived connection handling in Rust accept loop — separate sub-project.
2. **`tools/list_changed` notifications** — would require SSE.
3. **`prompts/get`** — handler exists but always returns `prompts not configured` (capability declared, no implementations).
4. **Roots from client** — `roots/list_changed` accepted as no-op. Brust doesn't use filesystem roots.
5. **Streaming long-running tool calls** — current actions are short. Add when a long-running action lands.
6. **Sampling (server→client LLM requests)** — Brust is the server, not the LLM consumer.
7. **OAuth / bearer-token auth for the MCP endpoint itself** — middleware on individual actions covers app-level auth. Endpoint-level auth deferred.
8. **Generic JSON Schema for non-primitive TS types** — MVP handles: string, number, boolean, null, arrays of primitives, plain object types with string keys → JSON Schema. Generics, unions, intersections, conditional types → fall back to `{}` (any). Document the gap; users with complex types can land a `withSchema` annotation later.

---

## 2. Architecture

### 2.1 Module layout

```
runtime/mcp/
├── extractor.ts        # TS compiler API: walk 'use server' files + route loaders → schemas
├── schema.ts           # TS type → JSON Schema conversion
├── manifest.ts         # build + read .brust/mcp-manifest.json
├── server.ts           # MCP JSON-RPC server (handlers for initialize/tools/resources/prompts/logging)
└── transport.ts        # POST request decoding + response encoding (HTTP layer)
```

`runtime/index.ts` adds `brust.serve({..., mcp?: { enabled: true } })` to opt in.

### 2.2 Boot sequence

```
example/hello-world/index.ts:
  const actions = await brust.scanActions({ roots: [import.meta.dirname] })

  if (!isWorker) {
    // ...existing build + register flow...

    // NEW: extract schemas + write manifest
    const manifest = await brust.buildMcpManifest({
      actions,
      routes,                    // FlatRoute[] from defineRoutes
      sourceRoots: [import.meta.dirname],
    })
    // Manifest is now at .brust/mcp-manifest.json + held in memory.

    await brust.serve({
      port, workers, entry: import.meta.url,
      actions,
      mcp: { manifest },         // OR: mcp: { enabled: true } and serve re-loads from disk
    })
  } else {
    // Worker: load manifest from disk (already written by main)
    const manifest = await brust.loadMcpManifest()
    const renderer = makeRenderer(routes, view, { actions, mcp: { manifest }, getWorkerId: () => wid })
  }
```

### 2.3 Rust route

Add a new native path handler in `src/server.rs`, parallel to the existing
action branch:

```rust
//  POST /_brust/mcp  →  forward body to worker with envelope kind: "mcp"
//  GET  /_brust/mcp  →  405 Method Not Allowed (SSE leg deferred)
```

The POST handler:
1. Reads body (UTF-8 JSON, JSON-RPC payload)
2. Validates Content-Type starts with `application/json`
3. Builds an MCP envelope with the JSON body verbatim
4. Dispatches to worker via tsfn, reads response via SAB (existing pattern)
5. Returns the JSON-RPC response with `Content-Type: application/json`

### 2.4 Worker dispatch envelope

Add a fourth `kind` variant to `runtime/routes.ts::RouteCall`:

```ts
| {
    kind: 'mcp'
    body_text: string       // raw JSON-RPC request body
    req: BrustRequest
  }
```

Rust `src/routes.rs::build_mcp_envelope` mirrors `build_action_envelope`.
The worker's `makeRenderer` adds an `mcpBranch` next to `renderBranch` and
`actionBranch`, dispatching the JSON-RPC request to the MCP server module.

---

## 3. MCP protocol surface

### 3.1 Implemented JSON-RPC methods

| Method | Behaviour |
|---|---|
| `initialize` | Return `{protocolVersion: "2025-06-18", capabilities: {...}, serverInfo: {name: "brust", version: <package.version>}}`. Accept any client protocol version ≥ "2024-11-05"; bump if mismatch. |
| `notifications/initialized` | No-op, no response. |
| `tools/list` | Return `manifest.tools` (array of `{ name, description, inputSchema }`). No pagination — Brust apps have at most ~100 actions; below the threshold. |
| `tools/call` | Dispatch the named action via `actionRegistry.get(name).fn(req, args)`. Arguments come from `params.arguments` (object, NOT positional array — MCP convention). Brust maps the object back to a positional array by reading the action's inputSchema's `properties` order. Return `{content: [{type: "text", text: JSON.stringify(result)}], isError: false}`. Errors → `{content: [...err message...], isError: true}`. |
| `resources/list` | Return `manifest.resources` (one per route loader). Each entry: `{uri: "brust:///<path-template>", name, description, mimeType: "application/json"}`. |
| `resources/read` | Parse the URI, match against a route in the table, extract params, invoke the loader, return `{contents: [{uri, mimeType: "application/json", text: JSON.stringify(loaderResult)}]}`. |
| `prompts/list` | Return `{prompts: []}` (empty, but capability declared). |
| `prompts/get` | Return JSON-RPC error `-32601 method not found` (or 404-style "prompt not found" if invoked with a name). |
| `logging/setLevel` | Accept the level, store in worker-local state, no notifications emitted (would need SSE — deferred). |
| `roots/list_changed` notification | No-op accept. |
| Unknown method | Return JSON-RPC error `-32601 method not found`. |

### 3.2 Tool naming

Action `id` becomes the MCP tool `name` verbatim. The id charset (`[A-Za-z0-9_-]+`, max 128) is already MCP-compatible (no special chars to escape).

### 3.3 Tool input shape

MCP convention: `tools/call.params.arguments` is an OBJECT keyed by parameter name. Brust actions receive POSITIONAL args. Mapping:

1. Read `manifest.tools[name].inputSchema.properties` — an ordered map (JSON Schema preserves declaration order via the underlying JSON object). Property keys are the action's parameter names.
2. For each property key in order, pull `params.arguments[key]` (or `undefined` if absent) → positional args array.
3. Call `def.fn(req, ...args)` (existing dispatch).

The `req` passed to the action is a SYNTHESISED `BrustRequest` (the MCP call has no underlying HTTP request beyond the MCP one — cookies / headers come from the MCP HTTP request itself, propagated via the envelope).

### 3.4 Resource URI templates

Each route with a `loader` becomes a resource. URI template:
- Route path `/blog/{slug}` → URI `brust:///blog/{slug}`
- Route path `/admin/users/{id}` → URI `brust:///admin/users/{id}`

Resources with NO loader are NOT exposed (the agent can't `read` something that doesn't return data).

### 3.5 Resource read flow

1. Parse `params.uri` → extract path portion (strip `brust:///` prefix).
2. Match the path against the loaded `routes: FlatRoute[]` using matchit (JS-side mirror of the Rust matcher, OR call into Rust for a single match).
3. Extract params from the match.
4. Find the route's `chain[i].loader` (use the LEAF's loader — chain inheritance not propagated for resources).
5. Invoke `loader({ params, path, req })` and return its return value as the resource content.

For MVP, do path matching in JS using a simple param-extraction function (matchit semantics aren't needed at full fidelity for `brust:///<known path>` lookups — exact + param routes only).

---

## 4. TS compiler API extractor

### 4.1 Inputs

- List of `'use server'` files (discovered by existing `scanActions`)
- List of route module files (just `routes.tsx` plus its imported components — actually only the routes.tsx itself, since that's where loaders are declared)
- `sourceRoots: [import.meta.dirname]` — passed by the user

### 4.2 Algorithm

```ts
import ts from 'typescript'

function extractMcpManifest(opts: {
  serverFiles: string[],
  routesFile: string,
  sourceRoots: string[],
}): McpManifest {
  // Compile a tiny in-memory program with these files + their imports.
  const program = ts.createProgram({
    rootNames: [...opts.serverFiles, opts.routesFile],
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.Preserve,
      allowJs: false,
      noEmit: true,
      skipLibCheck: true,
    },
  })
  const checker = program.getTypeChecker()

  const tools: ToolSchema[] = []
  for (const serverFile of opts.serverFiles) {
    const source = program.getSourceFile(serverFile)
    if (!source) continue
    ts.forEachChild(source, (node) => {
      if (ts.isFunctionDeclaration(node) && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
        tools.push(extractToolSchema(checker, node, serverFile))
      } else if (ts.isVariableStatement(node) && node.modifiers?.some(...)) {
        // export const x = withMiddleware([...], async fn) — extract fn's type
        for (const decl of node.declarationList.declarations) {
          if (ts.isVariableDeclaration(decl) && decl.initializer) {
            tools.push(extractToolSchemaFromCallExpr(checker, decl))
          }
        }
      }
    })
  }

  const resources = extractResources(checker, program.getSourceFile(opts.routesFile)!)
  return { tools, resources, version: 1 }
}
```

### 4.3 `extractToolSchema`

For a function signature like:
```ts
export async function createNote(req: BrustRequest, text: string): Promise<{ id: string }>
```

1. Identify the parameter list. The FIRST parameter is always `req: BrustRequest` and is dropped from the schema (it's not an agent-visible arg).
2. For each remaining param: extract its type via `checker.getTypeAtLocation(paramNode)`.
3. Map the TS type to JSON Schema using `tsTypeToJsonSchema` (S5).
4. Build `inputSchema = { type: "object", properties: {...}, required: [...] }`.
5. Optional: extract leading JSDoc as `description`.

For `withMiddleware([...], async (req, x) => {...})`:
1. Find the call expression `withMiddleware(...)`.
2. Get the SECOND argument (the function literal).
3. Use the function's parameter list as above.

### 4.4 `extractResources`

In the routes file, find `defineRoutes([...])` calls. Each `Route` literal's `loader` property is what we want:
1. Find object literal expressions inside the `defineRoutes` array.
2. For each, get the `loader: async (ctx) => {...}` property.
3. The loader's return type (inferred via `checker.getReturnTypeOfSignature`) becomes the resource's expected output shape — store as `outputSchema` per resource for documentation, even though MCP doesn't formally require it.
4. The route's `path` becomes the URI template.

### 4.5 Manifest shape

```ts
interface McpManifest {
  version: 1
  tools: Array<{
    name: string
    description?: string
    inputSchema: JsonSchema    // type: "object"
    outputSchema?: JsonSchema  // type from Promise<R> unwrapped — optional
    // For dispatch — maps schema property names to action param indices.
    // Lets tools/call rebuild positional args from object keys.
    paramOrder: string[]
  }>
  resources: Array<{
    uriTemplate: string        // 'brust:///blog/{slug}'
    name: string
    description?: string
    outputSchema?: JsonSchema
    routeIndex: number         // index into the FlatRoute[] for dispatch
  }>
}
```

Serialised to `.brust/mcp-manifest.json`.

---

## 5. TS type → JSON Schema conversion

### 5.1 Primitives

| TS type | JSON Schema |
|---|---|
| `string` | `{ type: "string" }` |
| `number` | `{ type: "number" }` |
| `boolean` | `{ type: "boolean" }` |
| `null` | `{ type: "null" }` |
| `undefined` | `{ type: "null" }` (MCP has no undefined; map to null) |
| `void` | omit (used for return; void return → no outputSchema) |
| `any` / `unknown` | `{}` (any) |
| `Date` | `{ type: "string", format: "date-time" }` |

### 5.2 Literal types

`'hello'` → `{ type: "string", enum: ["hello"] }`
`42` → `{ type: "number", enum: [42] }`
`true` → `{ type: "boolean", enum: [true] }`

### 5.3 Arrays

`string[]` or `Array<string>` → `{ type: "array", items: { type: "string" } }`

Tuple types: `[string, number]` → `{ type: "array", prefixItems: [{type:"string"}, {type:"number"}], minItems: 2, maxItems: 2 }`

### 5.4 Object types

```ts
{ id: string, count: number, optional?: boolean }
```
→
```json
{ "type": "object", "properties": { "id": {"type":"string"}, "count": {"type":"number"}, "optional": {"type":"boolean"} }, "required": ["id", "count"] }
```

Index signatures (`Record<string, T>`) → `{ type: "object", additionalProperties: <T schema> }`.

### 5.5 Unions

`string | number` → `{ anyOf: [{type:"string"}, {type:"number"}] }`

Discriminated unions: detected via shared literal property, but in MVP just emit `anyOf` of each member.

### 5.6 Promise unwrap

For return types: `Promise<T>` → unwrap T as the schema. `Promise<void>` → no outputSchema.

### 5.7 Fallback

Generics, intersections, conditional types, mapped types → emit `{}` (any). Log a warning at extraction time so the user knows the type isn't representable.

---

## 6. Worker MCP server (`runtime/mcp/server.ts`)

```ts
interface McpServer {
  /** Called once per MCP request reaching this worker. Returns the JSON-RPC
   * response as a string (ready for SAB write). */
  handleRequest(jsonRpcRequest: string, req: BrustRequest): Promise<string>
}

export function makeMcpServer(opts: {
  manifest: McpManifest
  actions: ActionDef[]
  routes: FlatRoute[]
}): McpServer
```

Implementation routes by JSON-RPC method to handlers:

```ts
async function handleRequest(reqStr: string, req: BrustRequest): Promise<string> {
  let rpc: JsonRpc
  try { rpc = JSON.parse(reqStr) } catch {
    return makeError(null, -32700, 'Parse error')
  }
  switch (rpc.method) {
    case 'initialize':            return handleInitialize(rpc)
    case 'notifications/initialized': return '' // no response for notifications
    case 'tools/list':            return handleToolsList(rpc)
    case 'tools/call':            return handleToolsCall(rpc, req)
    case 'resources/list':        return handleResourcesList(rpc)
    case 'resources/read':        return handleResourcesRead(rpc, req)
    case 'prompts/list':          return makeResult(rpc.id, { prompts: [] })
    case 'prompts/get':           return makeError(rpc.id, -32601, 'prompt not found')
    case 'logging/setLevel':      return makeResult(rpc.id, {})
    default:                      return makeError(rpc.id, -32601, 'method not found')
  }
}
```

Each handler is ~10-20 LOC; full server module ~200 LOC.

---

## 7. Rust changes

### 7.1 `src/server.rs` — new MCP branch

Add a path handler after the existing `/_brust/action/` branch:

```rust
if path == "/_brust/mcp" {
    if method != "POST" {
        let _ = s.write_all(http::error_405()).await;
        return;
    }
    // Read Content-Type, expect application/json (with charset variants).
    let content_type = parse_content_type(&buf[..header_end]).unwrap_or_default();
    if !content_type.to_ascii_lowercase().starts_with("application/json") {
        let _ = s.write_all(http::error_415()).await;
        return;
    }
    // ...read body (same shape as action branch — Content-Length + UTF-8 validate)...
    let envelope_json = crate::routes::build_mcp_envelope(
        &method, &path, body_str, &buf[..header_end],
    );
    match dispatch_to_worker_and_send_meta_response(
        &mut s, &pool, envelope_json,
        "mcp",
        "application/json; charset=utf-8",
        true,
        |_| {},
    ).await {
        DispatchControl::Continue => continue,
        DispatchControl::CloseConn => return,
    }
}
```

### 7.2 `src/routes.rs` — new envelope

```rust
#[derive(Serialize)]
pub struct McpEnvelope<'a> {
    pub kind: &'static str,         // "mcp"
    pub body_text: &'a str,         // raw JSON-RPC body
    pub req: RequestEnvelope,
}

pub fn build_mcp_envelope(
    method: &str,
    full_path: &str,
    body_text: &str,
    raw_request: &[u8],
) -> String { ... }
```

### 7.3 `runtime/routes.ts` — RouteCall MCP variant

```ts
| {
    kind: 'mcp'
    body_text: string
    req: BrustRequest
  }
```

`makeRenderer` adds a third branch `mcpBranch(call)` that delegates to `runtime/mcp/server.ts`.

---

## 8. Authentication

Tool calls go through the existing action middleware chain:

```ts
// Inside handleToolsCall:
const def = actionsById.get(toolName)
if (!def) return errorToolNotFound()
const args = mapArgumentsObjectToArray(manifest, toolName, params.arguments)
const terminal = async () => {
  const result = await def.fn(req, ...args)
  return { status: 200, body: JSON.stringify(result), contentType: 'application/json' }
}
const chain = composeChain(req, def.middleware, terminal)
const response = await chain()
if (response.status >= 400) {
  return makeError(rpc.id, response.status, response.body) // MCP error block
}
return makeResult(rpc.id, {
  content: [{ type: 'text', text: response.body }],
  isError: false,
})
```

Same `req` (with cookies/headers from the MCP HTTP request) is passed.
A middleware-gated action (e.g. `deleteNote` with `requireUser`) called via
MCP without an auth cookie returns the middleware's 401 — converted to an
MCP `isError: true` content block.

---

## 9. Testing strategy

### 9.1 Rust unit tests

`src/routes.rs`:
- `build_mcp_envelope_serialises_kind_mcp` — envelope shape, kind discriminant.
- `build_mcp_envelope_preserves_body_quotes` — JSON-RPC bodies with escaped quotes round-trip.

`src/server.rs`:
- already-tested helpers (`parse_content_type`, etc.) cover the MCP branch indirectly. Integration tests cover the full path.

### 9.2 Runtime unit tests

`runtime/mcp/schema.test.ts` (NEW):
- 15 tests covering TS → JSON Schema conversion: primitives, arrays, tuples, objects, optionals, unions, literals, Promise unwrap, fallback for unsupported.

`runtime/mcp/manifest.test.ts` (NEW):
- 5 tests for manifest build with a temp-dir fixture `'use server'` file.

### 9.3 Integration tests

`tests/integration.test.ts` (extend):

1. `mcp: initialize returns server capabilities` — POST `initialize`, expect `result.capabilities.tools`, `result.serverInfo.name === 'brust'`.
2. `mcp: tools/list returns all scanned actions` — POST `tools/list`, expect createNote / whoAmI / deleteNote / pingAction / uploadAvatar in result.
3. `mcp: tools/call createNote happy path` — POST `tools/call` with `{name:"createNote", arguments:{text:"hi"}}`, expect `result.content[0].text` to be valid JSON with `id`.
4. `mcp: tools/call middleware-gated action 401 → isError` — call `deleteNote` without cookie, expect `isError: true`.
5. `mcp: tools/call with cookie passes` — same but with cookie, expect success.
6. `mcp: resources/list returns loaders` — POST `resources/list`, expect `brust:///blog/{slug}` in the list.
7. `mcp: resources/read fetches loader output` — POST `resources/read` with `uri: "brust:///blog/foo"`, expect loader's title JSON.
8. `mcp: prompts/list returns empty` — POST `prompts/list`, expect `result.prompts === []`.
9. `mcp: unknown method → JSON-RPC -32601` — POST `methodThatDoesNotExist`, expect error code -32601.

Ports 38197-38205.

### 9.4 Example app demo

`example/hello-world/` — no new components. The existing `createNote`, `whoAmI`, etc. actions become MCP tools automatically.

Add to README (if one exists) or `architecture.md`: "Connect with `npx @modelcontextprotocol/inspector http://127.0.0.1:38900/_brust/mcp` to explore the agentic surface."

---

## 10. Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| `typescript` dep is heavy (~60 MB unpacked) | High (cost) | Bun's resolution lazy-loads `typescript` only when `buildMcpManifest()` is called. Apps without MCP pay nothing. Acknowledge in `runtime/package.json` peerDependency. |
| TS type extraction fails on complex generics (Promise<Conditional<...>>) | Med | Fall back to `{}` (any) and log warning. User can switch to manual schemas in a follow-up. |
| `tools/list` returns stale results if `.brust/mcp-manifest.json` is out of date | Low | Manifest rebuilt at every `brust.serve` boot. No watch-mode invalidation (matches scanActions pattern). |
| MCP protocol revision drift — agent uses older spec | Low | Accept any protocolVersion ≥ "2024-11-05"; return our preferred version. |
| Multipart action called via MCP — body should be JSON, not multipart | Low | `tools/call` JSON arguments object → positional args → `def.fn(req, ...args)`. Skips the form-body parsing path entirely. Forms-style actions (expecting FormData) called via MCP would receive a plain object as args[0] — agent must understand the action's signature. Documented limitation. |
| Resource URI template collision with action ids | Low | Resources use `brust:///` URI scheme; actions use bare names in `tools/call`. Different namespaces. |
| Boot time for TS extractor on large `'use server'` corpora | Med | Heuristic: TS compiler API on ~10 files takes ~500ms cold start. Cache to disk; only re-run if any source file's mtime changed (skip cache freshness check for MVP — always re-build at boot). |
| SSE leg absent — clients expecting streaming notifications fail | Low | Document POST-only mode in the spec. Clients that send `Accept: text/event-stream` get a 405 on GET. Stateless-mode-compliant per MCP spec. |
| `Mcp-Session-Id` header — MCP allows session-based reconnection. We don't issue one. | Low | Stateless mode is spec-allowed. Initialize returns `serverInfo` but no `Mcp-Session-Id`. Clients reconnecting work because no session state. |

---

## 11. Implementation order

Suggested task split (writing-plans will refine — execution deferred to next session):

1. **Rust: McpEnvelope + build_mcp_envelope + 2 unit tests** (~1 h)
2. **Rust: server.rs MCP branch + integration smoke (curl initialize)** (~1.5 h)
3. **JS: RouteCall MCP variant + mcpBranch stub in makeRenderer** (~30 min)
4. **JS: McpServer skeleton + initialize handler + makeError/makeResult helpers** (~1 h)
5. **JS: schema.ts (TS → JSON Schema) + 15 unit tests** (~3 h)
6. **JS: manifest.ts (build + write + read) + 5 unit tests** (~2 h)
7. **JS: extractor.ts (TS compiler API integration)** (~3 h)
8. **JS: tools/list + tools/call handlers (reuse action dispatch)** (~1.5 h)
9. **JS: resources/list + resources/read handlers** (~1.5 h)
10. **JS: prompts + logging + roots handlers (mostly no-ops)** (~30 min)
11. **Wire brust.serve({mcp}) + load manifest in workers** (~1 h)
12. **Integration tests — 9 new tests** (~2 h)
13. **architecture.md update + README MCP-connection blurb** (~30 min)

Total: ~19-20 hours focused work. Sized for a fresh session via subagent-driven-development.

---

## 12. Open follow-ups (post-MVP)

- SSE leg for streaming notifications (`notifications/progress`, `tools/list_changed`)
- `prompts/get` with user-supplied prompt templates
- Session management (`Mcp-Session-Id`) for stateful clients
- `withSchema(zSchema, fn)` annotation for complex types the TS extractor can't represent
- Mtime-based manifest cache invalidation
- OAuth / bearer token auth at the MCP endpoint level
- Sampling capability (server → client LLM)
- `notifications/resources/updated` for live data
- Resource subscription model
