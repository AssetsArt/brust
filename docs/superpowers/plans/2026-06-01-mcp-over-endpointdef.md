# Plan — MCP-over-EndpointDef rework

Spec: `docs/superpowers/specs/2026-06-01-mcp-over-endpointdef-design.md`
Base: `ef47ffd` (branch `feat/actions-treaty-client`)

## Conventions for every task
- **TS lint gate is biome, NOT cargo.** After ANY `.ts` edit run
  `bunx biome ci .` (must be 0 errors). `bunx tsc --noEmit` stack-overflows — do
  NOT use it.
- Do NOT `git add -A` (untracked `tools/` belongs to the user). Stage explicit
  paths only.
- Rust is untouched by this feature — do not edit `crates/`. (`cargo test -p
  brust` should remain a no-op pass; the orchestrator confirms in Phase 6.)
- Each task: write/adjust the test first (red), implement (green), run the
  listed verify commands, report DONE with the command output.

## Spec-coverage map
| Spec section | Task |
|---|---|
| ToolSchema shape (method/path, drop paramOrder) | T1 |
| Extraction algorithm + tool naming + params-from-path + body/query/output infer | T2 |
| `extractMcpManifest` opts (actionsFile) | T2 |
| `tools/call` via dispatchAction + byId + McpServerOptions.endpoints + remove LegacyActionDef | T3 |
| `EndpointOptions.description` | T3 |
| index.ts/build.ts wiring | T4 |
| Integration tools/list + tools/call + 422 + middleware | T5 |

---

## T1 — `ToolSchema` shape (mechanical, small)

**Edit `runtime/mcp/manifest.ts`** — replace the `ToolSchema` interface:

```ts
export interface ToolSchema {
  name: string
  description?: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'
  path: string
  inputSchema: JsonSchema
  outputSchema?: JsonSchema
}
```

(Remove the `paramOrder: string[]` line; add `method` + `path`.)

**Edit `runtime/mcp/manifest.test.ts`** — the literal at ~line 13-17 becomes:

```ts
      tools: [
        {
          name: 'foo',
          method: 'GET',
          path: '/foo',
          inputSchema: { type: 'object', properties: {}, required: [] },
        },
      ],
```

**Verify:**
```
bun test runtime/mcp/manifest.test.ts
bunx biome ci runtime/mcp/manifest.ts runtime/mcp/manifest.test.ts
```
Expected: manifest tests pass (5), biome 0 errors. (extractor.ts/server.ts will
NOT typecheck yet — that's fine, biome is a linter not a typechecker; do not run
`tsc`.)

---

## T2 — Extractor chain-walk (architecture; biggest task)

Rewrite `runtime/mcp/extractor.ts` to walk the `defineActions()` chain. Reuses
`tsTypeToJsonSchema` from `./schema.ts` unchanged.

### T2.1 — write the test first: `runtime/mcp/extractor.test.ts` (NEW)

Write an actions source to a temp dir and extract. The actions file must import
from the real runtime + zod so the checker resolves inferred types.

```ts
import { test, expect } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { extractMcpManifest } from './extractor.ts'

const RUNTIME = resolve(import.meta.dir, '..')

async function extractFrom(src: string) {
  const dir = await mkdtemp(join(tmpdir(), 'brust-extract-'))
  const actionsFile = join(dir, 'actions.ts')
  await writeFile(actionsFile, src)
  // routesFile can be a throwaway empty routes module — resources come from
  // the `routes` array, not the file, for these tests.
  const routesFile = join(dir, 'routes.tsx')
  await writeFile(routesFile, 'export const routes = []\n')
  const m = await extractMcpManifest({ actionsFile, routesFile, sourceRoots: [dir], routes: [] })
  return { m, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

const SRC = `
import { defineActions } from '${RUNTIME}/index.ts'
import { z } from 'zod'
export const actions = defineActions()
  .post('/notes', ({ body }) => ({ id: 'n-' + (body as { text: string }).text.length }), {
    body: z.object({ text: z.string() }),
    description: 'create a note',
  })
  .get('/notes/{id}', ({ params }) => ({ id: params.id }), {
    query: z.object({ verbose: z.boolean().optional() }),
  })
  .get('/whoami', () => ({ user: null as string | null }))
export type Actions = typeof actions
`

test('extractor: emits one name-sorted tool per endpoint', async () => {
  const { m, cleanup } = await extractFrom(SRC)
  try {
    expect(m.tools.map((t) => t.name)).toEqual(['get_notes_by_id', 'get_whoami', 'post_notes'])
    const post = m.tools.find((t) => t.name === 'post_notes')!
    expect(post.method).toBe('POST')
    expect(post.path).toBe('/notes')
    expect(post.description).toBe('create a note')
  } finally {
    await cleanup()
  }
})

test('extractor: post inputSchema nests body from inferred zod type', async () => {
  const { m, cleanup } = await extractFrom(SRC)
  try {
    const post = m.tools.find((t) => t.name === 'post_notes')!
    expect(post.inputSchema.properties?.body?.properties?.text).toEqual({ type: 'string' })
    // no params/query sub-objects on POST /notes
    expect(post.inputSchema.properties?.params).toBeUndefined()
    expect(post.inputSchema.properties?.query).toBeUndefined()
  } finally {
    await cleanup()
  }
})

test('extractor: get with param nests params (required string) + query', async () => {
  const { m, cleanup } = await extractFrom(SRC)
  try {
    const g = m.tools.find((t) => t.name === 'get_notes_by_id')!
    expect(g.inputSchema.properties?.params).toEqual({
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    })
    expect(g.inputSchema.properties?.query?.type).toBe('object')
    expect(g.inputSchema.properties?.body).toBeUndefined()
  } finally {
    await cleanup()
  }
})

test('extractor: no-arg endpoint has empty properties', async () => {
  const { m, cleanup } = await extractFrom(SRC)
  try {
    const w = m.tools.find((t) => t.name === 'get_whoami')!
    expect(w.inputSchema).toEqual({ type: 'object', properties: {} })
  } finally {
    await cleanup()
  }
})

test('extractor: duplicate tool-name slug throws', async () => {
  // /notes/{id} and /notes/by/id both slug to get_notes_by_id
  const src = `
import { defineActions } from '${RUNTIME}/index.ts'
export const actions = defineActions()
  .get('/notes/{id}', () => ({}))
  .get('/notes/by/id', () => ({}))
export type Actions = typeof actions
`
  const dir = await mkdtemp(join(tmpdir(), 'brust-extract-'))
  const actionsFile = join(dir, 'actions.ts')
  await writeFile(actionsFile, src)
  const routesFile = join(dir, 'routes.tsx')
  await writeFile(routesFile, 'export const routes = []\n')
  try {
    await expect(
      extractMcpManifest({ actionsFile, routesFile, sourceRoots: [dir], routes: [] }),
    ).rejects.toThrow(/duplicate.*tool name|get_notes_by_id/i)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('extractor: missing actionsFile yields zero tools', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brust-extract-'))
  const routesFile = join(dir, 'routes.tsx')
  await writeFile(routesFile, 'export const routes = []\n')
  try {
    const m = await extractMcpManifest({ routesFile, sourceRoots: [dir], routes: [] })
    expect(m.tools).toEqual([])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
```

### T2.2 — implement `runtime/mcp/extractor.ts`

Full rewrite. Keep `extractResources` and `matchUriPath`-adjacent helpers exactly
as-is (they're not in this file — `extractResources` IS here, keep it). Structure:

```ts
import ts from 'typescript'
import { tsTypeToJsonSchema, type JsonSchema } from './schema.ts'
import type { McpManifest, ToolSchema, ResourceSchema } from './manifest.ts'
import type { FlatRoute } from '../routes.ts'

export interface ExtractOptions {
  /** Module exporting `defineActions(...)`. Convention `<scanRoot>/actions.ts`.
   * Absent → zero tools (resources still extracted). */
  actionsFile?: string
  /** The routes module file. */
  routesFile: string
  /** User source roots. Reserved for future tsconfig resolution. */
  sourceRoots: string[]
  /** Result of `defineRoutes(...)`. */
  routes: FlatRoute[]
}

const METHODS: Record<string, ToolSchema['method']> = {
  get: 'GET', post: 'POST', put: 'PUT', patch: 'PATCH', delete: 'DELETE', head: 'HEAD',
}

export async function extractMcpManifest(opts: ExtractOptions): Promise<McpManifest> {
  const rootNames = [opts.routesFile]
  if (opts.actionsFile) rootNames.unshift(opts.actionsFile)
  const program = ts.createProgram({
    rootNames,
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.Preserve,
      allowJs: false,
      noEmit: true,
      skipLibCheck: true,
      strictNullChecks: true,
    },
  })
  const checker = program.getTypeChecker()

  const tools: ToolSchema[] = []
  if (opts.actionsFile) {
    const sf = program.getSourceFile(opts.actionsFile)
    if (sf) extractToolsFromActions(checker, sf, tools)
  }

  const resources = extractResources(checker, opts.routes, program.getSourceFile(opts.routesFile))

  tools.sort((a, b) => a.name.localeCompare(b.name))
  resources.sort((a, b) => a.uriTemplate.localeCompare(b.uriTemplate))
  return { version: 1, tools, resources }
}
```

**Chain walk + per-call extraction:**

```ts
function extractToolsFromActions(
  checker: ts.TypeChecker,
  sf: ts.SourceFile,
  out: ToolSchema[],
): void {
  // Find any `defineActions()` method chain anywhere in the file (export const
  // actions = defineActions()... — but tolerate other shapes).
  let chainTip: ts.CallExpression | undefined
  const visit = (node: ts.Node) => {
    if (
      !chainTip &&
      ts.isCallExpression(node) &&
      isDefineActionsChain(node)
    ) {
      chainTip = node
      return
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(sf, visit)
  if (!chainTip) return

  const calls = collectChainCalls(chainTip) // registration order
  const seen = new Set<string>()
  for (const call of calls) {
    const prop = call.expression as ts.PropertyAccessExpression
    const method = METHODS[prop.name.text.toLowerCase()]
    if (!method) continue // .use(...) etc.
    const pathArg = call.arguments[0]
    if (!pathArg || !ts.isStringLiteralLike(pathArg)) {
      console.warn(`[brust mcp] skipping endpoint with non-literal path (.${prop.name.text})`)
      continue
    }
    const path = pathArg.text
    const handler = call.arguments[1]
    const optsArg = call.arguments[2]
    const tool = buildTool(checker, method, path, handler, optsArg)
    if (seen.has(tool.name)) {
      throw new Error(
        `[brust mcp] duplicate tool name "${tool.name}" from ${method} ${path}; ` +
          `another endpoint slugs to the same name. Rename a path.`,
      )
    }
    seen.add(tool.name)
    out.push(tool)
  }
}

// True when the innermost receiver of this call chain is `defineActions(...)`.
function isDefineActionsChain(node: ts.CallExpression): boolean {
  let cur: ts.Expression = node
  while (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
    cur = cur.expression.expression
  }
  return ts.isCallExpression(cur) && ts.isIdentifier(cur.expression) &&
    cur.expression.text === 'defineActions'
}

// Collect each `.method(...)` CallExpression, outermost→inward, then reverse to
// registration order.
function collectChainCalls(node: ts.CallExpression): ts.CallExpression[] {
  const acc: ts.CallExpression[] = []
  let cur: ts.Expression = node
  while (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
    acc.push(cur)
    cur = cur.expression.expression
  }
  return acc.reverse()
}
```

**`buildTool` + naming + params-from-path + body/query/output:**

```ts
function buildTool(
  checker: ts.TypeChecker,
  method: ToolSchema['method'],
  path: string,
  handler: ts.Expression | undefined,
  optsArg: ts.Expression | undefined,
): ToolSchema {
  const props: Record<string, JsonSchema> = {}

  // params — from path {x}/{*x} segments (always string, required).
  const paramNames = parsePathParams(path)
  if (paramNames.length > 0) {
    const pprops: Record<string, JsonSchema> = {}
    for (const p of paramNames) pprops[p] = { type: 'string' }
    props.params = { type: 'object', properties: pprops, required: [...paramNames] }
  }

  // opts literal — detect body/query presence + read description.
  const optsLit = optsArg && ts.isObjectLiteralExpression(optsArg) ? optsArg : undefined
  const hasBody = optsLit ? hasProp(optsLit, 'body') : false
  const hasQuery = optsLit ? hasProp(optsLit, 'query') : false
  const description = optsLit ? readStringProp(optsLit, 'description') : undefined

  // handler ctx type — for body/query inference + output.
  const ctxType = handler ? handlerCtxType(checker, handler) : undefined
  if (hasBody && ctxType) {
    const s = ctxMemberSchema(checker, ctxType, 'body')
    if (s) props.body = s
  }
  if (hasQuery && ctxType) {
    const s = ctxMemberSchema(checker, ctxType, 'query')
    if (s) props.query = s
  }

  const inputSchema: JsonSchema = { type: 'object', properties: props }

  let outputSchema: JsonSchema | undefined
  if (handler) {
    const ret = handlerReturnType(checker, handler)
    if (ret) outputSchema = tsTypeToJsonSchema(ret, { checker, unwrapPromise: true })
  }

  return { name: toolName(method, path), description, method, path, inputSchema, outputSchema }
}

function toolName(method: ToolSchema['method'], path: string): string {
  const slug = path
    .replace(/^\//, '')
    .split('/')
    .filter((s) => s.length > 0)
    .map((seg) =>
      seg.startsWith('{') && seg.endsWith('}')
        ? 'by_' + seg.slice(1, -1).replace(/^\*/, '')
        : seg,
    )
    .join('_')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
  return `${method.toLowerCase()}_${slug}`.replace(/_+$/, '')
}

function parsePathParams(path: string): string[] {
  const out: string[] = []
  for (const m of path.matchAll(/\{(\*?)([^}]+)\}/g)) out.push(m[2])
  return out
}

function hasProp(lit: ts.ObjectLiteralExpression, name: string): boolean {
  return lit.properties.some(
    (p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
      p.name && ts.isIdentifier(p.name) && p.name.text === name,
  )
}

function readStringProp(lit: ts.ObjectLiteralExpression, name: string): string | undefined {
  for (const p of lit.properties) {
    if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === name &&
        ts.isStringLiteralLike(p.initializer)) {
      return p.initializer.text
    }
  }
  return undefined
}

// The handler's ctx (first param) type, via the call signature of the handler expr.
function handlerCtxType(checker: ts.TypeChecker, handler: ts.Expression): ts.Type | undefined {
  const t = checker.getTypeAtLocation(handler)
  const sig = t.getCallSignatures()[0]
  if (!sig) return undefined
  const p0 = sig.getParameters()[0]
  if (!p0) return undefined
  const decl = p0.valueDeclaration ?? p0.declarations?.[0]
  if (!decl) return undefined
  return checker.getTypeOfSymbolAtLocation(p0, decl)
}

function handlerReturnType(checker: ts.TypeChecker, handler: ts.Expression): ts.Type | undefined {
  const t = checker.getTypeAtLocation(handler)
  const sig = t.getCallSignatures()[0]
  return sig ? checker.getReturnTypeOfSignature(sig) : undefined
}

function ctxMemberSchema(
  checker: ts.TypeChecker,
  ctxType: ts.Type,
  member: 'body' | 'query',
): JsonSchema | undefined {
  const sym = ctxType.getProperty(member)
  if (!sym) return undefined
  const decl = sym.valueDeclaration ?? sym.declarations?.[0]
  const t = decl
    ? checker.getTypeOfSymbolAtLocation(sym, decl)
    : (checker as any).getTypeOfSymbol?.(sym)
  if (!t) return undefined
  return tsTypeToJsonSchema(t, { checker })
}
```

Keep `extractResources` and `getJsdoc` from the current file **unchanged** (remove
`getJsdoc` only if it becomes unused — biome will flag unused; if so, delete it).
Remove the `LegacyActionDef` import and the old `extractToolFromNode` /
`toolFromSignature` functions.

### T2 verify
```
bun test runtime/mcp/extractor.test.ts
bunx biome ci runtime/mcp/extractor.ts runtime/mcp/extractor.test.ts
```
Expected: 6 extractor tests pass; biome 0. If the `body` schema infers as `{}`
(loose) instead of `{properties:{text:...}}`, the handler-ctx inference failed —
report DONE_WITH_CONCERNS with the actual emitted schema; do NOT silently weaken
the test.

**BLOCKED fallback (T2):** if `handlerCtxType` can't resolve the inferred zod
type (body comes back `{}`/unknown), the pivot is to infer from the **opts
schema value type** instead: get the type of the `body:` property's initializer
expression in the opts literal (`checker.getTypeAtLocation(initializer)` →
`InferOutput` via the `~standard` validate return type), or fall back to reading
`StandardSchemaV1`'s output. If neither resolves richly, emit `{type:'object'}`
for body/query and note the limitation loudly — do not block the whole feature on
rich schemas; the runtime validation still enforces the real schema.

---

## T3 — Server dispatch via `dispatchAction` + `EndpointOptions.description`

### T3.1 — `EndpointOptions.description`
**Edit `runtime/define-actions.ts`** — add to `EndpointOptions`:
```ts
export interface EndpointOptions {
  body?: StandardSchemaV1
  query?: StandardSchemaV1
  middleware?: Middleware[]
  /** Build-time MCP tool description (read by the manifest extractor). */
  description?: string
}
```
(No runtime behavior change — `add()` ignores it.)

### T3.2 — write the test first: `runtime/mcp/server.test.ts` (NEW)
```ts
import { test, expect } from 'bun:test'
import { z } from 'zod'
import { defineActions } from '../define-actions.ts'
import { makeMcpServer } from './server.ts'
import type { McpManifest } from './manifest.ts'

const reqBase = { method: 'POST', headers: {}, cookies: {}, search: '' } as any

function setup() {
  const actions = defineActions()
    .post('/notes', ({ body }) => ({ id: 'n-' + (body as { text: string }).text.length }), {
      body: z.object({ text: z.string() }),
    })
    .delete('/notes/{id}', ({ params }) => ({ ok: true, id: params.id }), {
      middleware: [async (req, next) => (req.cookies['user'] ? next() : { status: 401, body: 'no' })],
    })
  const manifest: McpManifest = {
    version: 1,
    tools: [
      { name: 'post_notes', method: 'POST', path: '/notes',
        inputSchema: { type: 'object', properties: { body: { type: 'object' } } } },
      { name: 'delete_notes_by_id', method: 'DELETE', path: '/notes/{id}',
        inputSchema: { type: 'object', properties: {} } },
    ],
    resources: [],
  }
  return makeMcpServer({ manifest, endpoints: actions.endpoints, routes: [] })
}

async function call(srv: ReturnType<typeof makeMcpServer>, method: string, params: unknown, req = reqBase) {
  const out = await srv.handleRequest(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), req)
  return JSON.parse(out)
}

test('tools/list returns manifest tools', async () => {
  const r = await call(setup(), 'tools/list', undefined)
  expect(r.result.tools.map((t: any) => t.name)).toEqual(['post_notes', 'delete_notes_by_id'])
})

test('tools/call post_notes success', async () => {
  const r = await call(setup(), 'tools/call', { name: 'post_notes', arguments: { body: { text: 'hi' } } })
  expect(r.result.isError).toBe(false)
  expect(JSON.parse(r.result.content[0].text)).toEqual({ id: 'n-2' })
})

test('tools/call post_notes 422 on bad body', async () => {
  const r = await call(setup(), 'tools/call', { name: 'post_notes', arguments: { body: {} } })
  expect(r.result.isError).toBe(true)
  expect(r.result.content[0].text).toContain('validation')
})

test('tools/call middleware short-circuit (no cookie → isError)', async () => {
  const r = await call(setup(), 'tools/call',
    { name: 'delete_notes_by_id', arguments: { params: { id: 'x' } } },
    { ...reqBase, method: 'DELETE', cookies: {} })
  expect(r.result.isError).toBe(true)
})

test('tools/call middleware passes with cookie', async () => {
  const r = await call(setup(), 'tools/call',
    { name: 'delete_notes_by_id', arguments: { params: { id: 'x' } } },
    { ...reqBase, method: 'DELETE', cookies: { user: 'alice' } })
  expect(r.result.isError).toBe(false)
  expect(JSON.parse(r.result.content[0].text)).toEqual({ ok: true, id: 'x' })
})

test('tools/call unknown tool → -32601', async () => {
  const r = await call(setup(), 'tools/call', { name: 'nope', arguments: {} })
  expect(r.error.code).toBe(-32601)
})
```

### T3.3 — implement `runtime/mcp/server.ts`
- Remove the `LegacyActionDef` interface entirely.
- Change imports: add `import { dispatchAction } from '../routes.ts'` (static —
  verified no cycle) and `import type { EndpointDef } from '../define-actions.ts'`.
- `McpServerOptions`: replace `actions: LegacyActionDef[]` with
  `endpoints: EndpointDef[]`.
- In `makeMcpServer`, build the byId map once:
  ```ts
  const byId = new Map<string, EndpointDef>()
  for (const e of opts.endpoints) byId.set(`${e.method} ${e.path}`, e)
  ```
  (Capture `byId` in the closure; pass to `handleToolsCall`.)
- Rewrite `handleToolsCall`:
  ```ts
  async function handleToolsCall(
    rpc: JsonRpcRequest, opts: McpServerOptions, req: BrustRequest,
    byId: Map<string, EndpointDef>,
  ): Promise<string> {
    const params = rpc.params as { name?: string; arguments?: Record<string, unknown> } | undefined
    if (!params || typeof params.name !== 'string') {
      return makeError(rpc.id ?? null, -32602, 'tools/call: name required')
    }
    const tool = opts.manifest.tools.find((t) => t.name === params.name)
    if (!tool) return makeError(rpc.id ?? null, -32601, `unknown tool: ${params.name}`)
    const def = byId.get(`${tool.method} ${tool.path}`)
    if (!def) return makeError(rpc.id ?? null, -32603, `endpoint not registered: ${tool.name}`)

    const args = (params.arguments ?? {}) as {
      params?: Record<string, string>; query?: Record<string, string>; body?: unknown
    }
    const resp = await dispatchAction(
      {
        kind: 'action',
        action_id: `${tool.method} ${tool.path}`,
        content_type: 'application/json',
        params: args.params ?? {},
        body_text: args.body === undefined ? '' : JSON.stringify(args.body),
        req: { ...req, search: args.query ?? {} } as BrustRequest,
      } as never,
      byId,
    )
    return makeResult(rpc.id ?? null, {
      content: [{ type: 'text', text: resp.body || '' }],
      isError: resp.status >= 400,
    })
  }
  ```
  Update the `case 'tools/call':` dispatch to pass `byId`. Remove the dynamic
  `import('../routes.ts')` for `composeChain` (no longer used here).

### T3 verify
```
bun test runtime/mcp/server.test.ts
bunx biome ci runtime/mcp/server.ts runtime/define-actions.ts runtime/mcp/server.test.ts
```
Expected: 6 server tests pass; biome 0.

---

## T4 — Wiring (index.ts + build.ts)

**Edit `runtime/index.ts`:**
- `buildMcpManifest` opts type: remove `serverFiles: string[]` and
  `actions: import('./mcp/server.ts').LegacyActionDef[]`; add
  `actionsFile?: string`. Body stays (`extractMcpManifest(opts)`).
- `run()` main branch (~line 564): replace the `buildMcpManifest({ serverFiles:
  sourceFiles, routesFile, sourceRoots, actions: [], routes })` call with:
  ```ts
  const actionsFile = path.join(scanRoot, 'actions.ts')
  mcpManifest = await this.buildMcpManifest({
    actionsFile: existsSync(actionsFile) ? actionsFile : undefined,
    routesFile: path.join(scanRoot, 'routes.tsx'),
    sourceRoots: [scanRoot],
    routes,
  })
  ```
  (`existsSync` is already imported at line 288 region — confirm; it's imported
  inside `run()`.) Remove the now-unused `sourceFiles` var (line 315) if nothing
  else uses it — biome will flag.
- Worker branch (~line 645): `makeMcpServer({ manifest: mcpManifest, endpoints,
  routes: workerRoutes })` (was `actions: []`). `endpoints` is in scope from line
  314.

**Edit `runtime/cli/build.ts`** (~line 257):
```ts
const actionsFile = path.join(entryDir, 'actions.ts')
const manifest = await extractMcpManifest({
  actionsFile: existsSync(actionsFile) ? actionsFile : undefined,
  routesFile,
  sourceRoots: [entryDir],
  routes,
})
```
(`existsSync` and `path` already imported in build.ts — confirm.)

### T4 verify
```
bun test runtime/
bunx biome ci .
```
Expected: all runtime unit tests pass (including mcp/*), biome 0 errors across
the repo. This is the gate that proves the whole TS surface is consistent.

---

## T5 — Integration tests (acceptance)

**Edit `tests/integration.test.ts`** — replace the `mcp: tools/list is empty`
test (and its DEFERRED comment block ~line 812-826) with:

```ts
test('mcp: tools/list returns action-derived tools', async () => {
  const { port, stop } = await startServer({ rustLog: 'brust=warn' })
  try {
    const { body } = await mcpRequest(port, 'tools/list')
    const names = body.result.tools.map((t: any) => t.name).sort()
    expect(names).toContain('post_notes')
    expect(names).toContain('get_whoami')
    expect(names).toContain('delete_notes_by_id')
    const post = body.result.tools.find((t: any) => t.name === 'post_notes')
    expect(post.inputSchema.properties.body).toBeDefined()
  } finally {
    await stop()
  }
}, 15_000)

test('mcp: tools/call post_notes round-trips through dispatch', async () => {
  const { port, stop } = await startServer({ rustLog: 'brust=warn' })
  try {
    const { body } = await mcpRequest(port, 'tools/call', {
      name: 'post_notes', arguments: { body: { text: 'hi' } },
    })
    expect(body.result.isError).toBe(false)
    expect(JSON.parse(body.result.content[0].text)).toEqual({ id: 'n-2' })
  } finally {
    await stop()
  }
}, 15_000)

test('mcp: tools/call post_notes 422 on invalid body', async () => {
  const { port, stop } = await startServer({ rustLog: 'brust=warn' })
  try {
    const { body } = await mcpRequest(port, 'tools/call', {
      name: 'post_notes', arguments: { body: {} },
    })
    expect(body.result.isError).toBe(true)
  } finally {
    await stop()
  }
}, 15_000)

test('mcp: tools/call honors action middleware (cookie gate)', async () => {
  const { port, stop } = await startServer({ rustLog: 'brust=warn' })
  try {
    const no = await mcpRequest(port, 'tools/call',
      { name: 'delete_notes_by_id', arguments: { params: { id: 'x' } } })
    expect(no.body.result.isError).toBe(true)
    const yes = await mcpRequest(port, 'tools/call',
      { name: 'delete_notes_by_id', arguments: { params: { id: 'x' } } },
      { Cookie: 'user=alice' })
    expect(yes.body.result.isError).toBe(false)
    expect(JSON.parse(yes.body.result.content[0].text)).toEqual({ ok: true, id: 'x' })
  } finally {
    await stop()
  }
}, 15_000)
```

(Also remove the now-stale comment at integration.test.ts ~line 505 referencing
"MCP-tools-derived-from-actions tests were [removed]" if it claims the feature is
deferred — update it to reflect the feature shipped.)

### T5 verify
```
bun test tests/integration.test.ts
```
Expected: all integration tests pass (was 62; now 62 - 1 removed + 4 added = 65).
The `cli-build.test.ts /native-islands` failure is a DIFFERENT file and is
pre-existing/out-of-gate — do not touch it.

---

## Final gate (orchestrator, Phase 6 — not a subagent task)
Re-run by the orchestrator, not trusting subagent counts:
```
cargo fmt --check
cargo clippy --all-targets --locked -D warnings
cargo test -p brust
bunx biome ci .
bun test runtime/
bun test tests/treaty-integration.test.ts
bun test tests/integration.test.ts
# native-island after: rm -rf tests/fixtures/app/.brust tests/fixtures/app/dist
```
Plus a manual smoke: boot the fixture/example, `curl` a `tools/list` and a
`tools/call` and eyeball the JSON.
</content>
