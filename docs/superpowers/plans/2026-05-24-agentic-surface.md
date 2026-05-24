# Agentic Surface (MCP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Execution status:** DEFERRED to next session — session in which this plan was written had already shipped 4 Tier-2 features (Quick Wins + use-server + Forms + Nested Routes) and the ~20-hour scope of this feature exceeded remaining budget. Plan is written so next session can dispatch implementer subagents directly.

**Goal:** Mount a Model Context Protocol (MCP) 2025-06-18 server at `POST /_brust/mcp` that exposes server actions as tools, route loaders as resources, plus prompts/logging/roots capability stubs.

**Architecture:** New envelope `kind: "mcp"` routes JSON-RPC bodies through the existing worker pool. A JS module under `runtime/mcp/` parses requests, dispatches to handlers (initialize, tools/list, tools/call, resources/list, resources/read, prompts, logging, roots), and reuses the action runtime for `tools/call`. Schemas are extracted at boot via the TypeScript compiler API walking `'use server'` files + the routes module, cached to `.brust/mcp-manifest.json`.

**Tech Stack:** Rust 2024, TypeScript, Bun 1.4-canary, NEW dep `typescript` (peer/dev for TS compiler API), `bun:test`, no new Rust deps.

**Spec:** `docs/superpowers/specs/2026-05-24-agentic-surface-design.md`

---

## File map

| File | Action | Responsibility |
|---|---|---|
| `Cargo.toml` | no change | no new Rust deps |
| `runtime/package.json` | Modify | add `typescript` to peer/dev deps |
| `src/routes.rs` | Modify | Add `McpEnvelope` struct + `build_mcp_envelope` + 2 unit tests |
| `src/server.rs` | Modify | Add `/_brust/mcp` POST handler (mirror action branch) |
| `runtime/routes.ts` | Modify | Add `'mcp'` variant to `RouteCall` union; add `mcpBranch` dispatch in `makeRenderer` |
| `runtime/mcp/server.ts` | Create | MCP JSON-RPC handler module — switch on method, return response strings |
| `runtime/mcp/schema.ts` | Create | TS type → JSON Schema conversion (primitives, arrays, objects, unions, Promise unwrap, fallback) |
| `runtime/mcp/schema.test.ts` | Create | 15 unit tests for schema conversion |
| `runtime/mcp/extractor.ts` | Create | TS compiler API integration — walks 'use server' files + routes file, calls schema.ts to produce manifest |
| `runtime/mcp/manifest.ts` | Create | Build, write, read `.brust/mcp-manifest.json` |
| `runtime/mcp/manifest.test.ts` | Create | 5 unit tests for manifest build with temp-dir fixtures |
| `runtime/index.ts` | Modify | Add `brust.buildMcpManifest(...)`, `brust.loadMcpManifest()`, accept `mcp?` in `ServeOptions` |
| `example/hello-world/index.ts` | Modify | Call `brust.buildMcpManifest(...)` after `scanActions` in main; load manifest in worker |
| `tests/integration.test.ts` | Modify | Add 9 new MCP integration tests at ports 38197-38205 |
| `architecture.md` | Modify | Promote Agentic surface from "Designed not built" to "Built" |

---

## Task 1: Rust — `McpEnvelope` + `build_mcp_envelope` + unit tests

**Files:**
- Modify: `src/routes.rs`

- [ ] **Step 1: Write the failing tests**

Append to `src/routes.rs#[cfg(test)] mod tests`:

```rust
    #[test]
    fn mcp_envelope_serialises_kind_mcp() {
        let json = build_mcp_envelope(
            "POST",
            "/_brust/mcp",
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#,
            b"POST /_brust/mcp HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n\r\n",
        );
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["kind"], "mcp");
        assert_eq!(parsed["body_text"], r#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#);
        assert_eq!(parsed["req"]["method"], "POST");
    }

    #[test]
    fn mcp_envelope_preserves_inner_quotes() {
        let inner = r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"x","arguments":{"text":"hi \"there\""}}}"#;
        let json = build_mcp_envelope("POST", "/_brust/mcp", inner, b"");
        let outer: serde_json::Value = serde_json::from_str(&json).unwrap();
        let recovered: serde_json::Value = serde_json::from_str(outer["body_text"].as_str().unwrap()).unwrap();
        assert_eq!(recovered["params"]["arguments"]["text"], r#"hi "there""#);
    }
```

- [ ] **Step 2: Run and verify fail**

```bash
cargo test --lib mcp_envelope 2>&1 | tail -5
```

Expected: FAIL with `build_mcp_envelope` undefined.

- [ ] **Step 3: Implement struct + builder**

Append to `src/routes.rs` (near the existing `ActionEnvelope`):

```rust
/// MCP JSON-RPC request envelope. `kind: "mcp"` discriminates from render
/// and action variants. body_text carries the raw JSON-RPC payload — the
/// JS worker parses it once and dispatches by method.
#[derive(Serialize)]
pub struct McpEnvelope<'a> {
    pub kind: &'static str,
    pub body_text: &'a str,
    pub req: RequestEnvelope,
}

pub fn build_mcp_envelope(
    method: &str,
    full_path: &str,
    body_text: &str,
    raw_request: &[u8],
) -> String {
    let (_, query) = match full_path.split_once('?') {
        Some((p, q)) => (p, q),
        None => (full_path, ""),
    };
    let req = build_request_envelope(method, full_path, query, raw_request);
    let env = McpEnvelope {
        kind: "mcp",
        body_text,
        req,
    };
    serde_json::to_string(&env).unwrap()
}
```

- [ ] **Step 4: Run and verify pass**

```bash
cargo test --lib mcp_envelope 2>&1 | tail -5
cargo test --lib 2>&1 | tail -5
```

Expected: 2 new pass, total 57 Rust unit tests (55 prior + 2).

- [ ] **Step 5: Commit**

```bash
git add src/routes.rs
git commit -m "feat(rust): McpEnvelope + build_mcp_envelope

New envelope variant for MCP JSON-RPC requests. kind='mcp' discriminates
from render and action. body_text carries the raw JSON-RPC payload.

Tests: 2 new — basic shape + inner quote preservation.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Rust — `/_brust/mcp` POST handler in `server.rs`

**Files:**
- Modify: `src/server.rs`

- [ ] **Step 1: Add the path handler**

Find the existing `/_brust/action/` branch in `src/server.rs::handle_conn` (around line 222). Add this block AFTER it (still inside the request loop):

```rust
// Native-only route: MCP JSON-RPC server.
//   POST /_brust/mcp
// Body: JSON-RPC request. Worker dispatches by method.
// Status codes:
//   405 — non-POST method
//   411 — Content-Length missing
//   413 — Content-Length > SAB capacity
//   415 — Content-Type not application/json
//   400 — body not valid UTF-8
//   200 — JSON-RPC response (errors carried inside the body)
if path == "/_brust/mcp" {
    if method != "POST" {
        let _ = s.write_all(http::error_405()).await;
        return;
    }
    let content_type = parse_content_type(&buf[..header_end]).unwrap_or_default();
    if !content_type.to_ascii_lowercase().starts_with("application/json") {
        let _ = s.write_all(http::error_415()).await;
        return;
    }
    let header_end = match buf.windows(4).position(|w| w == b"\r\n\r\n") {
        Some(p) => p + 4,
        None => { let _ = s.write_all(http::error_400()).await; return; }
    };
    let content_length = match parse_content_length(&buf[..header_end]) {
        Some(n) => n,
        None => { let _ = s.write_all(http::error_411()).await; return; }
    };
    if content_length > MAX_ACTION_BODY_BYTES {
        let _ = s.write_all(http::error_413()).await;
        return;
    }
    let body_buffered = buf.len().saturating_sub(header_end);
    if body_buffered < content_length {
        let need = content_length - body_buffered;
        let mut read_so_far = 0usize;
        while read_so_far < need {
            let n = match s.read_request(&mut buf).await {
                Ok(n) => n,
                Err(_) => { let _ = s.write_all(http::error_400()).await; return; }
            };
            if n == 0 { let _ = s.write_all(http::error_400()).await; return; }
            read_so_far += n;
        }
    }
    let body_slice = &buf[header_end..header_end + content_length];
    let body_str = match std::str::from_utf8(body_slice) {
        Ok(s) => s,
        Err(_) => { let _ = s.write_all(http::error_400()).await; continue; }
    };

    let envelope_json = crate::routes::build_mcp_envelope(
        &method, &path, body_str, &buf[..header_end],
    );

    match dispatch_to_worker_and_send_meta_response(
        &mut s,
        &pool,
        envelope_json,
        "mcp",
        "application/json; charset=utf-8",
        true,
        |_| {},
    )
    .await
    {
        DispatchControl::Continue => continue,
        DispatchControl::CloseConn => return,
    }
}
```

- [ ] **Step 2: Build + smoke-test once worker side exists**

Skip running the smoke test in this task — Task 3 adds the worker stub. For now, just confirm `cargo build` succeeds:

```bash
cargo build 2>&1 | tail -5
```

Expected: clean (pre-existing dead_code warning only).

- [ ] **Step 3: Run all Rust tests**

```bash
cargo test --lib 2>&1 | tail -5
```

Expected: 57 pass / 0 fail.

- [ ] **Step 4: Commit**

```bash
git add src/server.rs
git commit -m "feat(rust): POST /_brust/mcp native dispatch

Mirrors the /_brust/action/<id> body-reading + tsfn dispatch shape.
Validates Content-Type, reads body bytes, builds an MCP envelope,
forwards to the worker via the existing dispatch helper. Worker
JSON-RPC handler lands in Task 3+.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: JS — `RouteCall` MCP variant + `mcpBranch` stub

**Files:**
- Modify: `runtime/routes.ts`

- [ ] **Step 1: Add MCP variant to RouteCall**

Find the `RouteCall` union (around line 98). Append a new variant:

```ts
  | {
      kind: 'mcp'
      body_text: string
      req: BrustRequest
    }
```

- [ ] **Step 2: Add `mcpBranch` stub**

Inside `makeRenderer`, after `actionBranch`, add a third branch:

```ts
if (call.kind === 'mcp') {
  return mcpBranch(call, view, encoder)
}
```

Append a stub `mcpBranch` function at file scope (or co-located with actionBranch):

```ts
async function mcpBranch(
  call: Extract<RouteCall, { kind: 'mcp' }>,
  view: Uint8Array,
  encoder: TextEncoder,
): Promise<number> {
  // Stubbed — real implementation in Task 4+ via runtime/mcp/server.ts
  return packResponse(view, encoder, {
    status: 501,
    body: '{"jsonrpc":"2.0","error":{"code":-32603,"message":"mcp not configured"}}',
    contentType: 'application/json; charset=utf-8',
  })
}
```

- [ ] **Step 3: Build + verify**

```bash
cd runtime && bun run build:debug && cd -
cargo build 2>&1 | tail -3
bun test ./tests/integration.test.ts 2>&1 | tail -5
```

Expected: 41 pass / 0 fail (no regression — MCP endpoint not yet exercised).

- [ ] **Step 4: Commit**

```bash
git add runtime/routes.ts
git commit -m "feat(runtime): RouteCall mcp variant + mcpBranch stub

JS dispatcher routes mcp envelopes through a stub that 501s. Real
JSON-RPC handlers land in subsequent tasks (server.ts + schema.ts +
handlers).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: JS — `runtime/mcp/server.ts` skeleton + `initialize` handler

**Files:**
- Create: `runtime/mcp/server.ts`
- Modify: `runtime/routes.ts` (wire `mcpBranch` to call the real server)

- [ ] **Step 1: Create `runtime/mcp/server.ts`**

```ts
import type { ActionDef } from '../actions.ts'
import type { FlatRoute, BrustRequest } from '../routes.ts'
import type { McpManifest } from './manifest.ts'

export interface McpServerOptions {
  manifest: McpManifest
  actions: ActionDef[]
  routes: FlatRoute[]
  packageVersion?: string
}

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: number | string | null
  method: string
  params?: unknown
}

interface JsonRpcSuccess<T> {
  jsonrpc: '2.0'
  id: number | string | null
  result: T
}

interface JsonRpcError {
  jsonrpc: '2.0'
  id: number | string | null
  error: { code: number, message: string, data?: unknown }
}

export interface McpServer {
  handleRequest(jsonRpcBody: string, req: BrustRequest): Promise<string>
}

export function makeMcpServer(opts: McpServerOptions): McpServer {
  return {
    async handleRequest(jsonRpcBody, req): Promise<string> {
      let rpc: JsonRpcRequest
      try {
        rpc = JSON.parse(jsonRpcBody)
      } catch {
        return makeError(null, -32700, 'Parse error')
      }
      if (rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') {
        return makeError(rpc.id ?? null, -32600, 'Invalid Request')
      }
      switch (rpc.method) {
        case 'initialize':
          return handleInitialize(rpc, opts)
        case 'notifications/initialized':
          return '' // No response for notifications.
        case 'tools/list':
        case 'tools/call':
        case 'resources/list':
        case 'resources/read':
        case 'prompts/list':
        case 'prompts/get':
        case 'logging/setLevel':
          return makeError(rpc.id ?? null, -32601, `${rpc.method} not implemented yet`)
        default:
          return makeError(rpc.id ?? null, -32601, `method not found: ${rpc.method}`)
      }
    }
  }
}

function handleInitialize(rpc: JsonRpcRequest, opts: McpServerOptions): string {
  return makeResult(rpc.id ?? null, {
    protocolVersion: '2025-06-18',
    capabilities: {
      tools: {},
      resources: {},
      prompts: {},
      logging: {},
      // roots is a client capability; not declared by server.
    },
    serverInfo: {
      name: 'brust',
      version: opts.packageVersion ?? '0.1.0',
    },
  })
}

export function makeResult(id: number | string | null, result: unknown): string {
  const resp: JsonRpcSuccess<unknown> = { jsonrpc: '2.0', id, result }
  return JSON.stringify(resp)
}

export function makeError(id: number | string | null, code: number, message: string): string {
  const resp: JsonRpcError = { jsonrpc: '2.0', id, error: { code, message } }
  return JSON.stringify(resp)
}
```

- [ ] **Step 2: Wire `mcpBranch` to call the server**

In `runtime/routes.ts`, find the `mcpBranch` stub. Replace its body to use the McpServer (instance configured by the renderer's options):

```ts
// Add to MakeRendererOptions:
export interface MakeRendererOptions {
  // ...existing fields...
  /** MCP server instance — built once per worker at module top-level. */
  mcp?: import('./mcp/server.ts').McpServer
}

async function mcpBranch(
  call: Extract<RouteCall, { kind: 'mcp' }>,
  view: Uint8Array,
  encoder: TextEncoder,
  mcp: import('./mcp/server.ts').McpServer | undefined,
): Promise<number> {
  if (!mcp) {
    return packResponse(view, encoder, {
      status: 501,
      body: '{"jsonrpc":"2.0","error":{"code":-32603,"message":"mcp not configured"}}',
      contentType: 'application/json; charset=utf-8',
    })
  }
  const responseJson = await mcp.handleRequest(call.body_text, call.req)
  if (responseJson === '') {
    // Notification — no response body. Return 204 No Content via meta envelope.
    return packResponse(view, encoder, {
      status: 204,
      body: '',
      contentType: 'application/json; charset=utf-8',
    })
  }
  return packResponse(view, encoder, {
    status: 200,
    body: responseJson,
    contentType: 'application/json; charset=utf-8',
  })
}
```

Update the call site in `makeRenderer` to pass `opts.mcp` through.

- [ ] **Step 3: Manual smoke-test `initialize`**

For now, we can't run the smoke test without wiring `brust.serve({mcp})` (Task 11). Skip live testing here — verify the module loads:

```bash
cd runtime && bunx tsc --noEmit 2>&1 | grep -E "mcp/server" | head -10
```

Expected: no errors specific to `runtime/mcp/server.ts`.

- [ ] **Step 4: Commit**

```bash
git add runtime/routes.ts runtime/mcp/server.ts
git commit -m "feat(runtime): McpServer skeleton + initialize handler

Module routes JSON-RPC requests by method to handlers. Initialize
returns MCP 2025-06-18 capabilities + brust serverInfo. Other methods
return -32601 (method not implemented) until subsequent tasks wire them.

makeRenderer accepts an mcp option (McpServer instance) — when present,
mcpBranch dispatches to it; absent, returns 501 'mcp not configured'.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: JS — `runtime/mcp/schema.ts` (TS type → JSON Schema) + 15 unit tests

**Files:**
- Create: `runtime/mcp/schema.ts`
- Create: `runtime/mcp/schema.test.ts`

- [ ] **Step 1: Write the 15 failing tests**

Create `runtime/mcp/schema.test.ts`. Cover:

```ts
import { test, expect } from 'bun:test'
import ts from 'typescript'
import { tsTypeToJsonSchema } from './schema.ts'

function typeOf(source: string, varName: string): ts.Type {
  const fileName = 'test.ts'
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true)
  const host = ts.createCompilerHost({})
  const orig = host.getSourceFile
  host.getSourceFile = (fn, ...rest) => fn === fileName ? sourceFile : orig.call(host, fn, ...rest)
  const program = ts.createProgram({
    rootNames: [fileName], options: { noEmit: true, target: ts.ScriptTarget.ES2022, skipLibCheck: true },
    host,
  })
  const checker = program.getTypeChecker()
  const decl = sourceFile.statements.find((s): s is ts.VariableStatement => ts.isVariableStatement(s))!
  const v = decl.declarationList.declarations.find((d) => (d.name as ts.Identifier).text === varName)!
  return checker.getTypeAtLocation(v)
}

test('schema: string primitive', () => {
  const t = typeOf('const x: string = ""', 'x')
  expect(tsTypeToJsonSchema(t)).toEqual({ type: 'string' })
})

test('schema: number primitive', () => {
  const t = typeOf('const x: number = 0', 'x')
  expect(tsTypeToJsonSchema(t)).toEqual({ type: 'number' })
})

test('schema: boolean primitive', () => {
  const t = typeOf('const x: boolean = false', 'x')
  expect(tsTypeToJsonSchema(t)).toEqual({ type: 'boolean' })
})

test('schema: null', () => {
  const t = typeOf('const x: null = null', 'x')
  expect(tsTypeToJsonSchema(t)).toEqual({ type: 'null' })
})

test('schema: string literal', () => {
  const t = typeOf('const x: "hello" = "hello"', 'x')
  expect(tsTypeToJsonSchema(t)).toEqual({ type: 'string', enum: ['hello'] })
})

test('schema: array of strings', () => {
  const t = typeOf('const x: string[] = []', 'x')
  expect(tsTypeToJsonSchema(t)).toEqual({ type: 'array', items: { type: 'string' } })
})

test('schema: tuple', () => {
  const t = typeOf('const x: [string, number] = ["", 0]', 'x')
  expect(tsTypeToJsonSchema(t)).toEqual({
    type: 'array',
    prefixItems: [{ type: 'string' }, { type: 'number' }],
    minItems: 2,
    maxItems: 2,
  })
})

test('schema: object with required + optional', () => {
  const t = typeOf('const x: { a: string, b?: number } = { a: "" }', 'x')
  expect(tsTypeToJsonSchema(t)).toEqual({
    type: 'object',
    properties: { a: { type: 'string' }, b: { type: 'number' } },
    required: ['a'],
  })
})

test('schema: nested object', () => {
  const t = typeOf('const x: { a: { b: string } } = { a: { b: "" } }', 'x')
  expect(tsTypeToJsonSchema(t)).toEqual({
    type: 'object',
    properties: { a: { type: 'object', properties: { b: { type: 'string' } }, required: ['b'] } },
    required: ['a'],
  })
})

test('schema: union string | number', () => {
  const t = typeOf('const x: string | number = ""', 'x')
  expect(tsTypeToJsonSchema(t)).toEqual({ anyOf: [{ type: 'string' }, { type: 'number' }] })
})

test('schema: Record<string, number>', () => {
  const t = typeOf('const x: Record<string, number> = {}', 'x')
  expect(tsTypeToJsonSchema(t)).toEqual({ type: 'object', additionalProperties: { type: 'number' } })
})

test('schema: Promise<T> unwraps', () => {
  const t = typeOf('const x: Promise<string> = Promise.resolve("")', 'x')
  // Use Promise-aware variant; the helper exposes unwrapPromise: true option:
  expect(tsTypeToJsonSchema(t, { unwrapPromise: true })).toEqual({ type: 'string' })
})

test('schema: Promise<void> → undefined', () => {
  const t = typeOf('const x: Promise<void> = Promise.resolve()', 'x')
  expect(tsTypeToJsonSchema(t, { unwrapPromise: true })).toBeUndefined()
})

test('schema: any → {} (any)', () => {
  const t = typeOf('const x: any = 0', 'x')
  expect(tsTypeToJsonSchema(t)).toEqual({})
})

test('schema: Date → string date-time', () => {
  const t = typeOf('const x: Date = new Date()', 'x')
  expect(tsTypeToJsonSchema(t)).toEqual({ type: 'string', format: 'date-time' })
})
```

- [ ] **Step 2: Run tests to verify fail**

```bash
cd runtime && bun test mcp/schema.test.ts 2>&1 | tail -10
```

Expected: FAIL — `tsTypeToJsonSchema` not defined.

- [ ] **Step 3: Implement `schema.ts`**

Create `runtime/mcp/schema.ts`:

```ts
import ts from 'typescript'

export interface JsonSchema {
  type?: string | string[]
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  prefixItems?: JsonSchema[]
  minItems?: number
  maxItems?: number
  additionalProperties?: JsonSchema | boolean
  anyOf?: JsonSchema[]
  enum?: unknown[]
  format?: string
}

export interface ToJsonSchemaOptions {
  unwrapPromise?: boolean
  checker?: ts.TypeChecker  // required for object/property iteration
}

export function tsTypeToJsonSchema(type: ts.Type, opts: ToJsonSchemaOptions = {}): JsonSchema | undefined {
  const flags = type.flags
  // Unwrap Promise<T> at the top level when asked.
  if (opts.unwrapPromise) {
    const inner = unwrapPromise(type, opts.checker)
    if (inner === undefined) return undefined
    if (inner) return tsTypeToJsonSchema(inner, { ...opts, unwrapPromise: false })
  }
  // void → undefined (caller treats as "no schema")
  if (flags & ts.TypeFlags.Void) return undefined
  // any/unknown
  if (flags & ts.TypeFlags.Any || flags & ts.TypeFlags.Unknown) return {}
  // null
  if (flags & ts.TypeFlags.Null || flags & ts.TypeFlags.Undefined) return { type: 'null' }
  // string literal
  if (flags & ts.TypeFlags.StringLiteral) return { type: 'string', enum: [(type as ts.StringLiteralType).value] }
  // number literal
  if (flags & ts.TypeFlags.NumberLiteral) return { type: 'number', enum: [(type as ts.NumberLiteralType).value] }
  // boolean literal
  if (flags & ts.TypeFlags.BooleanLiteral) {
    const v = (type as any).intrinsicName === 'true'
    return { type: 'boolean', enum: [v] }
  }
  if (flags & ts.TypeFlags.String) return { type: 'string' }
  if (flags & ts.TypeFlags.Number) return { type: 'number' }
  if (flags & ts.TypeFlags.Boolean) return { type: 'boolean' }
  // Union
  if (type.isUnion()) {
    return { anyOf: type.types.map((t) => tsTypeToJsonSchema(t, opts)).filter((x): x is JsonSchema => x !== undefined) }
  }
  // Date special case
  const symbol = type.getSymbol()
  if (symbol?.name === 'Date') return { type: 'string', format: 'date-time' }
  // Array
  if (opts.checker) {
    const typeAsAny = type as any
    if (typeAsAny.typeArguments && opts.checker.isArrayType?.(type)) {
      const inner = typeAsAny.typeArguments[0]
      return { type: 'array', items: tsTypeToJsonSchema(inner, opts) ?? {} }
    }
    // Tuple
    if (opts.checker.isTupleType?.(type)) {
      const args = typeAsAny.typeArguments ?? []
      return {
        type: 'array',
        prefixItems: args.map((t: ts.Type) => tsTypeToJsonSchema(t, opts) ?? {}),
        minItems: args.length,
        maxItems: args.length,
      }
    }
    // Object: enumerate properties
    if (flags & ts.TypeFlags.Object) {
      const props = type.getProperties()
      // Record<string, T> detection: single string index signature
      const stringIndex = type.getStringIndexType()
      if (props.length === 0 && stringIndex) {
        return { type: 'object', additionalProperties: tsTypeToJsonSchema(stringIndex, opts) ?? {} }
      }
      const properties: Record<string, JsonSchema> = {}
      const required: string[] = []
      for (const p of props) {
        const decl = p.declarations?.[0]
        if (!decl) continue
        const propType = opts.checker.getTypeOfSymbolAtLocation(p, decl)
        const propSchema = tsTypeToJsonSchema(propType, opts)
        if (propSchema) {
          properties[p.name] = propSchema
          if (!(p.flags & ts.SymbolFlags.Optional)) {
            required.push(p.name)
          }
        }
      }
      const out: JsonSchema = { type: 'object', properties }
      if (required.length > 0) out.required = required
      return out
    }
  }
  // Fallback: any (loses information but agent still works)
  return {}
}

function unwrapPromise(type: ts.Type, checker?: ts.TypeChecker): ts.Type | null | undefined {
  // Type returned: ts.Type unwrapped; null = unwrap result is void; undefined = not a Promise.
  const symbol = type.getSymbol()
  if (symbol?.name === 'Promise') {
    const args = (type as any).typeArguments
    if (args && args.length === 1) {
      const inner = args[0] as ts.Type
      if (inner.flags & ts.TypeFlags.Void) return null
      return inner
    }
  }
  return undefined
}
```

NOTE: the test fixture in Step 1 builds a Program without supplying `checker` to `tsTypeToJsonSchema`. For object/array tests to work, the test needs to pass `checker` from the same program. Update the test helper `typeOf` to also return the checker:

```ts
function typeOf(source: string, varName: string): { type: ts.Type, checker: ts.TypeChecker } {
  // ... existing setup ...
  return { type: checker.getTypeAtLocation(v), checker }
}
```

And rewrite each `tsTypeToJsonSchema(t)` call to `tsTypeToJsonSchema(t, { checker: c })` where `c` is the returned checker. Update primitive tests accordingly (passing the checker is harmless for primitives).

- [ ] **Step 4: Run tests**

```bash
cd runtime && bun test mcp/schema.test.ts 2>&1 | tail -10
```

Expected: 15 pass / 0 fail.

If a test fails, the type flags / symbol matching is the most likely cause. Debug with `console.log(ts.TypeFlags[type.flags], type.getSymbol()?.name)`.

- [ ] **Step 5: Commit**

```bash
git add runtime/mcp/schema.ts runtime/mcp/schema.test.ts
git commit -m "feat(runtime): TS type → JSON Schema converter + 15 tests

Supports: primitives (string/number/boolean/null/Date), literals,
arrays, tuples, plain objects (with optional → required[]), Record
index signatures, unions, Promise<T> unwrap. Unknown/generic types
fall back to {} (any).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: JS — `runtime/mcp/manifest.ts` (build, write, read) + 5 unit tests

**Files:**
- Create: `runtime/mcp/manifest.ts`
- Create: `runtime/mcp/manifest.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `runtime/mcp/manifest.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeManifest, readManifest, type McpManifest } from './manifest.ts'

test('manifest: write and read round-trip', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brust-mcp-'))
  try {
    const manifest: McpManifest = {
      version: 1,
      tools: [{
        name: 'foo',
        inputSchema: { type: 'object', properties: {}, required: [] },
        paramOrder: [],
      }],
      resources: [],
    }
    await writeManifest(dir, manifest)
    const out = await readManifest(dir)
    expect(out).toEqual(manifest)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('manifest: readManifest returns null when missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brust-mcp-'))
  try {
    expect(await readManifest(dir)).toBeNull()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('manifest: writeManifest creates .brust/ directory if missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brust-mcp-'))
  try {
    await writeManifest(dir, { version: 1, tools: [], resources: [] })
    const out = await readManifest(dir)
    expect(out).not.toBeNull()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('manifest: readManifest rejects version mismatch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brust-mcp-'))
  try {
    await Bun.write(join(dir, '.brust', 'mcp-manifest.json'), JSON.stringify({ version: 999, tools: [], resources: [] }))
    expect(readManifest(dir)).rejects.toThrow(/version mismatch/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('manifest: readManifest rejects malformed JSON', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brust-mcp-'))
  try {
    await Bun.write(join(dir, '.brust', 'mcp-manifest.json'), '{not json')
    expect(readManifest(dir)).rejects.toThrow()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: Run tests to verify fail**

```bash
cd runtime && bun test mcp/manifest.test.ts 2>&1 | tail -10
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `manifest.ts`**

```ts
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { JsonSchema } from './schema.ts'

export interface ToolSchema {
  name: string
  description?: string
  inputSchema: JsonSchema
  outputSchema?: JsonSchema
  paramOrder: string[]
}

export interface ResourceSchema {
  uriTemplate: string
  name: string
  description?: string
  outputSchema?: JsonSchema
  routeIndex: number
}

export interface McpManifest {
  version: 1
  tools: ToolSchema[]
  resources: ResourceSchema[]
}

const MANIFEST_PATH = '.brust/mcp-manifest.json'

export async function writeManifest(cwd: string, m: McpManifest): Promise<void> {
  const path = join(cwd, MANIFEST_PATH)
  await mkdir(join(cwd, '.brust'), { recursive: true })
  await Bun.write(path, JSON.stringify(m, null, 2))
}

export async function readManifest(cwd: string): Promise<McpManifest | null> {
  const path = join(cwd, MANIFEST_PATH)
  const f = Bun.file(path)
  if (!(await f.exists())) return null
  const text = await f.text()
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch (e) {
    throw new Error(`mcp-manifest.json is malformed: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (!parsed || typeof parsed !== 'object' || (parsed as McpManifest).version !== 1) {
    throw new Error(`mcp-manifest.json version mismatch (expected 1)`)
  }
  return parsed as McpManifest
}
```

- [ ] **Step 4: Run tests**

```bash
cd runtime && bun test mcp/manifest.test.ts 2>&1 | tail -10
```

Expected: 5 pass / 0 fail.

- [ ] **Step 5: Commit**

```bash
git add runtime/mcp/manifest.ts runtime/mcp/manifest.test.ts
git commit -m "feat(runtime): mcp-manifest.json read/write helpers

Persists the extracted schema cache at .brust/mcp-manifest.json
(parallel to .brust/islands/). Version-tagged for forward-compat;
malformed/wrong-version JSON throws clearly. Auto-creates .brust/
dir on first write.

Tests: 5 unit tests cover round-trip + missing-file + mkdir + version
mismatch + malformed JSON.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: JS — `runtime/mcp/extractor.ts` (TS compiler API integration)

**Files:**
- Create: `runtime/mcp/extractor.ts`
- Modify: `runtime/package.json` (add `typescript` dep)

- [ ] **Step 1: Add typescript dep**

```bash
cd runtime
bun add -d typescript
cd -
```

Verify `runtime/package.json` now lists `typescript` under devDependencies (or dependencies — implementer's call).

- [ ] **Step 2: Create `extractor.ts`**

```ts
import ts from 'typescript'
import { tsTypeToJsonSchema, type JsonSchema } from './schema.ts'
import type { McpManifest, ToolSchema, ResourceSchema } from './manifest.ts'
import type { ActionDef, FlatRoute } from '../routes.ts'

export interface ExtractOptions {
  /** Files that have 'use server' directive — provided by scanActions. */
  serverFiles: string[]
  /** The routes module file (e.g. example/hello-world/routes.tsx). */
  routesFile: string
  /** The user's source roots (for tsconfig resolution). */
  sourceRoots: string[]
  /** Result of `await brust.scanActions(...)` — maps action ids to ActionDef. */
  actions: ActionDef[]
  /** Result of `defineRoutes(...)`. */
  routes: FlatRoute[]
}

export async function extractMcpManifest(opts: ExtractOptions): Promise<McpManifest> {
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
  const actionIds = new Set(opts.actions.map((a) => a.id))

  for (const serverFile of opts.serverFiles) {
    const sf = program.getSourceFile(serverFile)
    if (!sf) continue
    ts.forEachChild(sf, (node) => {
      const tool = extractToolFromNode(checker, node, actionIds)
      if (tool) tools.push(tool)
    })
  }

  const resources = extractResources(checker, opts.routes, program.getSourceFile(opts.routesFile))

  // Sort tools/resources alphabetically for stable manifest.
  tools.sort((a, b) => a.name.localeCompare(b.name))
  resources.sort((a, b) => a.uriTemplate.localeCompare(b.uriTemplate))

  return { version: 1, tools, resources }
}

function extractToolFromNode(checker: ts.TypeChecker, node: ts.Node, actionIds: Set<string>): ToolSchema | null {
  // Case 1: export async function name(req, ...args)
  if (ts.isFunctionDeclaration(node) && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) && node.name) {
    const name = node.name.text
    if (!actionIds.has(name)) return null
    return toolFromSignature(checker, name, node.parameters, node.type, getJsdoc(node))
  }
  // Case 2: export const name = withMiddleware([...], async (req, ...args) => ...)
  if (ts.isVariableStatement(node) && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
    for (const decl of node.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) continue
      const name = decl.name.text
      if (!actionIds.has(name)) continue
      // Find the function expression inside withMiddleware(...).
      const init = decl.initializer
      if (init && ts.isCallExpression(init)) {
        const fnArg = init.arguments[1]
        if (fnArg && (ts.isArrowFunction(fnArg) || ts.isFunctionExpression(fnArg))) {
          return toolFromSignature(checker, name, fnArg.parameters, fnArg.type, getJsdoc(node))
        }
      }
    }
  }
  return null
}

function toolFromSignature(
  checker: ts.TypeChecker,
  name: string,
  parameters: ts.NodeArray<ts.ParameterDeclaration>,
  returnTypeNode: ts.TypeNode | undefined,
  description: string | undefined,
): ToolSchema {
  // Drop the first parameter (req: BrustRequest).
  const argParams = parameters.slice(1)
  const properties: Record<string, JsonSchema> = {}
  const required: string[] = []
  const paramOrder: string[] = []
  for (const p of argParams) {
    if (!ts.isIdentifier(p.name)) continue
    const pname = p.name.text
    paramOrder.push(pname)
    const t = checker.getTypeAtLocation(p)
    const schema = tsTypeToJsonSchema(t, { checker }) ?? {}
    properties[pname] = schema
    if (!p.questionToken) required.push(pname)
  }
  const inputSchema: JsonSchema = { type: 'object', properties }
  if (required.length > 0) inputSchema.required = required

  let outputSchema: JsonSchema | undefined
  if (returnTypeNode) {
    const returnType = checker.getTypeFromTypeNode(returnTypeNode)
    outputSchema = tsTypeToJsonSchema(returnType, { checker, unwrapPromise: true })
  }

  return { name, description, inputSchema, outputSchema, paramOrder }
}

function extractResources(
  checker: ts.TypeChecker,
  routes: FlatRoute[],
  routesSourceFile: ts.SourceFile | undefined,
): ResourceSchema[] {
  const out: ResourceSchema[] = []
  for (let i = 0; i < routes.length; i++) {
    const fr = routes[i]
    const leaf = fr.chain[fr.chain.length - 1]
    if (!leaf.loader) continue
    // outputSchema extraction is best-effort — look up the loader's type via the source file.
    // Skipped for MVP — leaves outputSchema undefined; MCP still works.
    out.push({
      uriTemplate: `brust://${fr.fullPath}`,
      name: `loader for ${fr.fullPath}`,
      routeIndex: i,
    })
  }
  return out
}

function getJsdoc(node: ts.Node): string | undefined {
  const tags = ts.getJSDocCommentsAndTags(node)
  if (tags.length === 0) return undefined
  const first = tags[0]
  if (ts.isJSDoc(first) && typeof first.comment === 'string') return first.comment
  return undefined
}
```

- [ ] **Step 3: Smoke-test the extractor**

Run a one-shot script to verify it extracts something sensible from the example app:

```bash
cd /Users/detoro/code/brust
cat > /tmp/extract-smoke.ts <<'EOF'
import { extractMcpManifest } from './runtime/mcp/extractor.ts'

const manifest = await extractMcpManifest({
  serverFiles: ['/Users/detoro/code/brust/example/hello-world/actions.ts'],
  routesFile: '/Users/detoro/code/brust/example/hello-world/routes.tsx',
  sourceRoots: ['/Users/detoro/code/brust/example/hello-world'],
  actions: [
    { id: 'createNote', fn: async () => {} },
    { id: 'whoAmI', fn: async () => {} },
    { id: 'deleteNote', fn: async () => {} },
    { id: 'pingAction', fn: async () => {} },
    { id: 'uploadAvatar', fn: async () => {} },
  ] as any,
  routes: [] as any,
})
console.log(JSON.stringify(manifest, null, 2))
EOF
bun run /tmp/extract-smoke.ts
rm /tmp/extract-smoke.ts
```

Expected: JSON output with `tools` array containing createNote (`{ type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }`), and the other 4 actions.

If TS extraction crashes or returns empty, debug — common causes:
- `ts.createProgram` can't find the file (check absolute paths)
- The source file uses JSX syntax (.tsx) which needs `jsx: ts.JsxEmit.Preserve` in compiler options
- `getTypeAtLocation` returns `unknown` for action params (means TS didn't resolve `BrustRequest` import; provide a stub `lib` or add the runtime to rootNames)

- [ ] **Step 4: Commit**

```bash
git add runtime/mcp/extractor.ts runtime/package.json runtime/bun.lock
git commit -m "feat(runtime): TS compiler API extractor for MCP manifest

Walks 'use server' files + the routes module, extracts function
signatures via ts.createProgram + TypeChecker. First param (BrustRequest)
is dropped from each tool's inputSchema. Return type is unwrapped via
the Promise-aware schema converter.

Resources are emitted for every route that has a loader. outputSchema
for resources is best-effort (defaults to undefined; MCP doesn't require
it).

Adds typescript as a devDependency.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: JS — `tools/list` + `tools/call` handlers

**Files:**
- Modify: `runtime/mcp/server.ts`

- [ ] **Step 1: Implement `tools/list` and `tools/call`**

Replace the `case 'tools/list':` and `case 'tools/call':` placeholders in `runtime/mcp/server.ts` with real handlers:

```ts
case 'tools/list':
  return handleToolsList(rpc, opts)
case 'tools/call':
  return handleToolsCall(rpc, opts, req)
```

Add the helpers at file scope (after `handleInitialize`):

```ts
async function handleToolsList(rpc: JsonRpcRequest, opts: McpServerOptions): Promise<string> {
  const tools = opts.manifest.tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    outputSchema: t.outputSchema,
  }))
  return makeResult(rpc.id ?? null, { tools })
}

async function handleToolsCall(rpc: JsonRpcRequest, opts: McpServerOptions, req: BrustRequest): Promise<string> {
  const params = rpc.params as { name?: string; arguments?: Record<string, unknown> } | undefined
  if (!params || typeof params.name !== 'string') {
    return makeError(rpc.id ?? null, -32602, 'tools/call: name required')
  }
  const tool = opts.manifest.tools.find((t) => t.name === params.name)
  if (!tool) {
    return makeError(rpc.id ?? null, -32601, `unknown tool: ${params.name}`)
  }
  const action = opts.actions.find((a) => a.id === params.name)
  if (!action) {
    return makeError(rpc.id ?? null, -32603, `action not registered: ${params.name}`)
  }
  // Map { argsObject } → positional args via paramOrder.
  const args = (tool.paramOrder ?? []).map((k) => params.arguments?.[k])

  // Run through middleware chain (same shape as actionBranch).
  const { composeChain } = await import('../routes.ts')
  const terminal = async () => {
    try {
      const result = await action.fn(req, ...args)
      return {
        status: 200,
        body: result === undefined ? '' : JSON.stringify(result),
        contentType: 'application/json; charset=utf-8',
      }
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      return {
        status: 500,
        body: JSON.stringify({ error: { message: e.message, name: e.name } }),
        contentType: 'application/json; charset=utf-8',
      }
    }
  }
  const chain = composeChain(req, action.middleware, terminal)
  const response = await chain()
  if (response.status >= 400) {
    return makeResult(rpc.id ?? null, {
      content: [{ type: 'text', text: response.body }],
      isError: true,
    })
  }
  return makeResult(rpc.id ?? null, {
    content: [{ type: 'text', text: response.body || '' }],
    isError: false,
  })
}
```

Note: `composeChain` may not be exported from `runtime/routes.ts` today. If not, export it OR copy the helper into `server.ts`. Implementer's call — exporting is cleaner.

- [ ] **Step 2: Build + verify type-check**

```bash
cd runtime && bunx tsc --noEmit 2>&1 | grep -E "mcp/server" | head -10
```

Expected: no errors specific to `mcp/server.ts`.

- [ ] **Step 3: Commit**

```bash
git add runtime/mcp/server.ts runtime/routes.ts
git commit -m "feat(runtime): tools/list + tools/call handlers

tools/list returns manifest.tools (name/description/inputSchema/outputSchema).
tools/call validates the tool name, maps the arguments object → positional
args via paramOrder, runs the action's middleware chain (parent-then-leaf
preserved), returns content+isError per MCP spec.

A middleware-gated action called via tools/call without auth still 401s
— surfaced as isError: true.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: JS — `resources/list` + `resources/read` handlers

**Files:**
- Modify: `runtime/mcp/server.ts`

- [ ] **Step 1: Implement `resources/list` and `resources/read`**

Replace the placeholders in `server.ts`:

```ts
case 'resources/list':
  return handleResourcesList(rpc, opts)
case 'resources/read':
  return handleResourcesRead(rpc, opts, req)
```

Add helpers:

```ts
async function handleResourcesList(rpc: JsonRpcRequest, opts: McpServerOptions): Promise<string> {
  const resources = opts.manifest.resources.map((r) => ({
    uri: r.uriTemplate,
    name: r.name,
    description: r.description,
    mimeType: 'application/json',
  }))
  return makeResult(rpc.id ?? null, { resources })
}

async function handleResourcesRead(rpc: JsonRpcRequest, opts: McpServerOptions, req: BrustRequest): Promise<string> {
  const params = rpc.params as { uri?: string } | undefined
  if (!params || typeof params.uri !== 'string') {
    return makeError(rpc.id ?? null, -32602, 'resources/read: uri required')
  }
  // Strip the brust:// scheme.
  const prefix = 'brust://'
  if (!params.uri.startsWith(prefix)) {
    return makeError(rpc.id ?? null, -32602, `unsupported URI scheme: ${params.uri}`)
  }
  const requestedPath = params.uri.slice(prefix.length)

  // Match against the routes. Walk opts.routes to find one whose fullPath
  // pattern matches the URI's path portion.
  const match = matchUriPath(requestedPath, opts.routes)
  if (!match) {
    return makeError(rpc.id ?? null, -32601, `no route matches URI ${params.uri}`)
  }
  const route = opts.routes[match.routeIndex]
  const leaf = route.chain[route.chain.length - 1]
  if (!leaf.loader) {
    return makeError(rpc.id ?? null, -32603, `route ${route.fullPath} has no loader`)
  }
  try {
    const data = await leaf.loader({ params: match.params, path: requestedPath, req })
    return makeResult(rpc.id ?? null, {
      contents: [{
        uri: params.uri,
        mimeType: 'application/json',
        text: JSON.stringify(data),
      }],
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return makeError(rpc.id ?? null, -32603, `loader error: ${msg}`)
  }
}

interface UriMatch {
  routeIndex: number
  params: Record<string, string>
}

function matchUriPath(requestedPath: string, routes: FlatRoute[]): UriMatch | null {
  // Simple param matching: split both into segments and match.
  const reqSegs = requestedPath.split('/').filter((s) => s.length > 0)
  for (let i = 0; i < routes.length; i++) {
    const fr = routes[i]
    const routeSegs = fr.fullPath.split('/').filter((s) => s.length > 0)
    if (reqSegs.length !== routeSegs.length) continue
    const params: Record<string, string> = {}
    let matched = true
    for (let j = 0; j < reqSegs.length; j++) {
      const rseg = routeSegs[j]
      if (rseg.startsWith('{') && rseg.endsWith('}')) {
        params[rseg.slice(1, -1)] = reqSegs[j]
      } else if (rseg !== reqSegs[j]) {
        matched = false
        break
      }
    }
    if (matched) return { routeIndex: i, params }
  }
  return null
}
```

- [ ] **Step 2: Type-check + commit**

```bash
cd runtime && bunx tsc --noEmit 2>&1 | grep "mcp/server" | head -10
git add runtime/mcp/server.ts
git commit -m "feat(runtime): resources/list + resources/read handlers

resources/list returns manifest.resources mapped to MCP shape.
resources/read parses 'brust://...' URIs, matches against the route
table, extracts params, invokes the leaf route's loader, returns
the JSON-stringified result as a single content block.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: JS — `prompts` + `logging` + `roots` stubs

**Files:**
- Modify: `runtime/mcp/server.ts`

- [ ] **Step 1: Implement stub handlers**

Replace placeholders in `server.ts`:

```ts
case 'prompts/list':
  return makeResult(rpc.id ?? null, { prompts: [] })
case 'prompts/get':
  return makeError(rpc.id ?? null, -32601, 'no prompts configured')
case 'logging/setLevel':
  // Accept the level; no notifications emitted (SSE deferred).
  return makeResult(rpc.id ?? null, {})
case 'notifications/roots/list_changed':
  // No-op accept (it's a notification, no response).
  return ''
```

- [ ] **Step 2: Commit**

```bash
git add runtime/mcp/server.ts
git commit -m "feat(runtime): prompts/logging/roots stub handlers

- prompts/list returns empty array (capability declared but no prompts)
- prompts/get returns -32601 'no prompts configured'
- logging/setLevel accepts the level no-op (SSE leg deferred)
- notifications/roots/list_changed is a no-op accept

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Wire `brust.serve({mcp})` + load manifest in workers

**Files:**
- Modify: `runtime/index.ts`
- Modify: `example/hello-world/index.ts`

- [ ] **Step 1: Add `brust.buildMcpManifest` + `brust.loadMcpManifest`**

In `runtime/index.ts`, add inside the `brust` object:

```ts
async buildMcpManifest(opts: {
  serverFiles: string[]
  routesFile: string
  sourceRoots: string[]
  actions: import('./actions.ts').ActionDef[]
  routes: import('./routes.ts').FlatRoute[]
  cwd?: string
}): Promise<import('./mcp/manifest.ts').McpManifest> {
  const { extractMcpManifest } = await import('./mcp/extractor.ts')
  const { writeManifest } = await import('./mcp/manifest.ts')
  const m = await extractMcpManifest(opts)
  await writeManifest(opts.cwd ?? process.cwd(), m)
  return m
},

async loadMcpManifest(cwd: string = process.cwd()): Promise<import('./mcp/manifest.ts').McpManifest | null> {
  const { readManifest } = await import('./mcp/manifest.ts')
  return readManifest(cwd)
},
```

Update `ServeOptions`:

```ts
export interface ServeOptions {
  // ...existing fields...
  /** MCP support — when present, requests to POST /_brust/mcp are
   * dispatched through a JSON-RPC server backed by this manifest.
   * Main process builds it via brust.buildMcpManifest; workers load
   * it from disk via brust.loadMcpManifest. */
  mcp?: { manifest: import('./mcp/manifest.ts').McpManifest }
}
```

The `mcp` field doesn't change Rust's behavior — Rust always routes `/_brust/mcp` to the worker; the worker decides whether to respond meaningfully (via the McpServer instance passed to makeRenderer).

- [ ] **Step 2: Update `example/hello-world/index.ts`**

```ts
const actions = await brust.scanActions({ roots: [import.meta.dirname] })

if (!isWorker) {
  const { port, workers, cacheMaxEntries } = await loadConfig()

  // ...existing build + register flow...

  brust.registerRoutes(routes)

  // NEW: build MCP manifest (only main process — workers read from disk).
  const mcpManifest = await brust.buildMcpManifest({
    serverFiles: [/* paths to 'use server' files — see notes below */],
    routesFile: new URL('./routes.tsx', import.meta.url).pathname,
    sourceRoots: [import.meta.dirname],
    actions,
    routes,
  })
  console.log(`[brust] main: mcp manifest has ${mcpManifest.tools.length} tools + ${mcpManifest.resources.length} resources`)

  await brust.serve({
    port, workers, entry: import.meta.url,
    actions,
    mcp: { manifest: mcpManifest },
  })
} else {
  // ...existing worker init...
  const mcpManifest = await brust.loadMcpManifest(import.meta.dirname)
  let mcpServer: McpServer | undefined
  if (mcpManifest) {
    const { makeMcpServer } = await import('../../runtime/mcp/server.ts')
    mcpServer = makeMcpServer({ manifest: mcpManifest, actions, routes })
  }
  const renderer = makeRenderer(routes, view, { actions, getWorkerId: () => wid, mcp: mcpServer })
}
```

**Note on serverFiles:** `scanActions` doesn't currently expose the list of files it walked. The implementer has two options:
- (a) Extend `scanActions` to return `{ actions, sourceFiles }` instead of just `ActionDef[]`. Backward-incompat for any external consumer (none exist).
- (b) Re-walk the source roots from main using a copy of the directive check from `scan-actions.ts`.

Recommend (a). Update the relevant tasks accordingly during execution.

- [ ] **Step 3: Smoke-test end-to-end**

Build + launch:

```bash
cd /Users/detoro/code/brust/runtime && bun run build:debug && cd -
BRUST_PORT=38950 bun run example/hello-world/index.ts > /tmp/mcp-smoke.log 2>&1 &
PID=$!
sleep 8

grep "mcp manifest" /tmp/mcp-smoke.log

# initialize
curl -s -X POST -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}' \
  http://127.0.0.1:38950/_brust/mcp | head -c 300
echo

# tools/list
curl -s -X POST -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  http://127.0.0.1:38950/_brust/mcp | head -c 500
echo

# tools/call createNote
curl -s -X POST -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"createNote","arguments":{"text":"hello"}}}' \
  http://127.0.0.1:38950/_brust/mcp | head -c 300
echo

kill $PID 2>/dev/null
wait $PID 2>/dev/null
rm -f /tmp/mcp-smoke.log
```

Expected:
- "mcp manifest has 5 tools + 1 resources" in log
- initialize returns serverInfo + capabilities
- tools/list returns 5 tools alphabetical
- tools/call returns `{"id":"n-..."}` as content text

If any check fails, STOP and diagnose.

- [ ] **Step 4: Commit**

```bash
git add runtime/index.ts example/hello-world/index.ts
git commit -m "feat(runtime + example): brust.buildMcpManifest + brust.serve mcp wiring

brust.buildMcpManifest runs the TS compiler API extractor + writes the
manifest to .brust/mcp-manifest.json. brust.loadMcpManifest reads it
back (used by workers).

brust.serve gains an optional mcp.manifest field; when present, the
worker spins up an McpServer for handling /_brust/mcp requests.

Example app wires it end-to-end: scanActions → buildMcpManifest →
serve({mcp}), with workers loading the manifest from disk.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Integration tests — 9 new MCP tests

**Files:**
- Modify: `tests/integration.test.ts`

- [ ] **Step 1: Append 9 tests**

Append to `tests/integration.test.ts`:

```ts
async function mcpRequest(port: number, method: string, params?: unknown, headers: Record<string, string> = {}): Promise<any> {
  const resp = await fetch(`http://127.0.0.1:${port}/_brust/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  return { status: resp.status, body: await resp.json() }
}

test('mcp: initialize returns server capabilities', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: { ...process.env, BRUST_PORT: '38197', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const { status, body } = await mcpRequest(port, 'initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' },
    })
    expect(status).toBe(200)
    expect(body.result.protocolVersion).toBe('2025-06-18')
    expect(body.result.serverInfo.name).toBe('brust')
    expect(body.result.capabilities.tools).toBeDefined()
    expect(body.result.capabilities.resources).toBeDefined()
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)

test('mcp: tools/list returns all scanned actions', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: { ...process.env, BRUST_PORT: '38198', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const { body } = await mcpRequest(port, 'tools/list')
    const names = body.result.tools.map((t: any) => t.name).sort()
    expect(names).toContain('createNote')
    expect(names).toContain('whoAmI')
    expect(names).toContain('deleteNote')
    expect(names).toContain('pingAction')
    expect(names).toContain('uploadAvatar')
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)

test('mcp: tools/call createNote happy path', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: { ...process.env, BRUST_PORT: '38199', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const { body } = await mcpRequest(port, 'tools/call', {
      name: 'createNote',
      arguments: { text: 'hello via mcp' },
    })
    expect(body.result.isError).toBe(false)
    const result = JSON.parse(body.result.content[0].text)
    expect(result.id).toMatch(/^n-\d+$/)
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)

test('mcp: tools/call middleware-gated action without cookie → isError', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: { ...process.env, BRUST_PORT: '38200', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const { body } = await mcpRequest(port, 'tools/call', {
      name: 'deleteNote',
      arguments: { noteId: 'n-1' },
    })
    expect(body.result.isError).toBe(true)
    expect(body.result.content[0].text).toContain('login required')
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)

test('mcp: tools/call with cookie passes middleware', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: { ...process.env, BRUST_PORT: '38201', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const { body } = await mcpRequest(port, 'tools/call', {
      name: 'deleteNote',
      arguments: { noteId: 'n-1' },
    }, { 'cookie': 'user=alice' })
    expect(body.result.isError).toBe(false)
    const result = JSON.parse(body.result.content[0].text)
    expect(result.ok).toBe(true)
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)

test('mcp: resources/list returns loaders', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: { ...process.env, BRUST_PORT: '38202', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const { body } = await mcpRequest(port, 'resources/list')
    const uris = body.result.resources.map((r: any) => r.uri)
    expect(uris).toContain('brust:///blog/{slug}')
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)

test('mcp: resources/read fetches loader output', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: { ...process.env, BRUST_PORT: '38203', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const { body } = await mcpRequest(port, 'resources/read', { uri: 'brust:///blog/hello' })
    expect(body.result.contents).toHaveLength(1)
    const content = body.result.contents[0]
    expect(content.uri).toBe('brust:///blog/hello')
    const data = JSON.parse(content.text)
    expect(data.title).toBe('Post: hello')
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)

test('mcp: prompts/list returns empty', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: { ...process.env, BRUST_PORT: '38204', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const { body } = await mcpRequest(port, 'prompts/list')
    expect(body.result.prompts).toEqual([])
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)

test('mcp: unknown method returns -32601', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: { ...process.env, BRUST_PORT: '38205', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const { body } = await mcpRequest(port, 'nonexistentMethod')
    expect(body.error.code).toBe(-32601)
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)
```

- [ ] **Step 2: Run new tests**

```bash
bun test ./tests/integration.test.ts --test-name-pattern "mcp:" 2>&1 | tail -10
```

Expected: `9 pass / 0 fail`.

- [ ] **Step 3: Run full suite**

```bash
bun test ./tests/integration.test.ts 2>&1 | tail -5
```

Expected: `50 pass / 0 fail` (41 prior + 9 new).

- [ ] **Step 4: Commit**

```bash
git add tests/integration.test.ts
git commit -m "test(integration): 9 new MCP tests at ports 38197-38205

- initialize → capabilities + serverInfo
- tools/list → 5 actions
- tools/call → createNote happy path
- tools/call → middleware blocks deleteNote without cookie
- tools/call → cookie unblocks deleteNote
- resources/list → contains brust:///blog/{slug}
- resources/read → fetches blog loader output
- prompts/list → empty array
- unknown method → -32601

50 integration tests pass total.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: `architecture.md` update

**Files:**
- Modify: `architecture.md`

- [ ] **Step 1: Move Agentic surface entry**

Find the "Designed not built" entry for Agentic surface and delete it.

Add to the "Built" list (near `'use server'` directive / Forms / Nested Routes):

```markdown
- **Agentic surface (MCP)** — Mounts a Model Context Protocol 2025-06-18 server at `POST /_brust/mcp`. Server actions (discovered by `brust.scanActions()`) become MCP **tools**; route loaders become **resources** at `brust:///<path-template>`. Schemas are extracted at boot via the TypeScript compiler API and cached to `.brust/mcp-manifest.json`. Capabilities declared: tools, resources, prompts (empty), logging, roots. Transport: POST-only (SSE leg for streaming notifications is deferred). Authentication: tool calls flow through the action's existing middleware chain — gated tools still 401.
```

- [ ] **Step 2: Add to README / connection blurb (optional)**

If a README.md exists at the repo root, add a section like:

```markdown
## Agent integration (MCP)

Connect any MCP client to `http://127.0.0.1:<port>/_brust/mcp`:

```bash
npx @modelcontextprotocol/inspector http://127.0.0.1:38900/_brust/mcp
```

Every `'use server'` action is exposed as a tool. Every route loader is a resource.
```

If no README, just leave the architecture.md update.

- [ ] **Step 3: Commit**

```bash
git add architecture.md
git commit -m "docs(architecture): agentic surface (MCP) shipped

Moves the entry from Designed not built to Built. Documents the MCP
2025-06-18 surface, the JS-side TS compiler API extractor, and the
.brust/mcp-manifest.json cache. Notes the deferred SSE leg.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Spec coverage check (self-review)

| Spec § | Task |
|---|---|
| §1 Goal — MCP server with tools/resources/prompts/logging/roots | Tasks 4, 8, 9, 10 |
| §1 Success criterion + concrete acceptance curls | Tasks 11 (smoke), 12 (automated) |
| §2.1 Module layout | Tasks 4-7 (creates the modules) |
| §2.2 Boot sequence | Task 11 |
| §2.3 Rust route | Tasks 1, 2 |
| §2.4 Worker dispatch envelope | Tasks 1, 3 |
| §3.1 Implemented JSON-RPC methods | Tasks 4 (initialize), 8 (tools), 9 (resources), 10 (prompts/logging/roots) |
| §3.2-§3.5 Tool/resource semantics | Tasks 8, 9 |
| §4 TS compiler API extractor | Task 7 |
| §5 TS type → JSON Schema | Task 5 |
| §6 Worker MCP server | Tasks 4, 8, 9, 10 |
| §7 Rust changes | Tasks 1, 2 |
| §8 Authentication via middleware chain | Task 8 (tools/call uses composeChain) |
| §9 Testing strategy | Tasks 1, 5, 6, 12 |

All spec sections mapped. No requirements without a task.

**Type-consistency check:** `McpEnvelope`, `RouteCall` 'mcp' variant, `McpManifest`, `ToolSchema`, `ResourceSchema`, `JsonSchema`, `tsTypeToJsonSchema`, `extractMcpManifest`, `writeManifest`, `readManifest`, `makeMcpServer`, `brust.buildMcpManifest`, `brust.loadMcpManifest` — all consistent across tasks.
