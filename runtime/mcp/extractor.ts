import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import type { FlatRoute } from '../routes.ts'
import type { McpManifest, ResourceSchema, ToolSchema } from './manifest.ts'
import { type JsonSchema, tsTypeToJsonSchema } from './schema.ts'

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
  get: 'GET',
  post: 'POST',
  put: 'PUT',
  patch: 'PATCH',
  delete: 'DELETE',
  head: 'HEAD',
}

export async function extractMcpManifest(opts: ExtractOptions): Promise<McpManifest> {
  const rootNames = [opts.routesFile]
  if (opts.actionsFile) rootNames.unshift(opts.actionsFile)
  // Resolve bare specifiers (zod, etc.) that the actions file imports. Normal
  // walk-up resolution finds the user's own node_modules; the wildcard fallback
  // points at the brust runtime's node_modules so inferred schema types resolve
  // even when the actions file lives outside a node_modules tree (e.g. tests).
  const runtimeNodeModules = findRuntimeNodeModules()
  const paths: Record<string, string[]> = { '*': ['*'] }
  if (runtimeNodeModules) paths['*'].push(join(runtimeNodeModules, '*'))
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
      // The brust runtime imports modules with explicit `.ts` extensions.
      allowImportingTsExtensions: true,
      baseUrl: opts.sourceRoots[0] ?? dirname(rootNames[0]),
      paths,
      // Required: TS 5.x collapses string | null to plain string without strict
      // null checks, which would silently drop the null variant from the schema.
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

// Walk up from this module's directory to the nearest node_modules that has a
// resolvable schema dep (zod). Returns the node_modules path or undefined.
function findRuntimeNodeModules(): string | undefined {
  let cur = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 12; i++) {
    const nm = join(cur, 'node_modules')
    if (existsSync(join(nm, 'zod'))) return nm
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return undefined
}

function extractToolsFromActions(
  checker: ts.TypeChecker,
  sf: ts.SourceFile,
  out: ToolSchema[],
): void {
  // Find any `defineActions()` method chain anywhere in the file (export const
  // actions = defineActions()... — but tolerate other shapes).
  let chainTip: ts.CallExpression | undefined
  const visit = (node: ts.Node) => {
    if (!chainTip && ts.isCallExpression(node) && isDefineActionsChain(node)) {
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
    // safe: collectChainCalls only enqueues nodes with a PropertyAccessExpression receiver
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
  return (
    ts.isCallExpression(cur) &&
    ts.isIdentifier(cur.expression) &&
    cur.expression.text === 'defineActions'
  )
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
      seg.startsWith('{') && seg.endsWith('}') ? `by_${seg.slice(1, -1).replace(/^\*/, '')}` : seg,
    )
    .join('_')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
  // Root path '/' yields an empty slug — name it '<method>_root' so it stays
  // descriptive and distinct rather than a bare '<method>'.
  if (slug === '') return `${method.toLowerCase()}_root`
  return `${method.toLowerCase()}_${slug}`.replace(/_+$/, '')
}

function parsePathParams(path: string): string[] {
  const out: string[] = []
  for (const m of path.matchAll(/\{(\*?)([^}]+)\}/g)) out.push(m[2])
  return out
}

function hasProp(lit: ts.ObjectLiteralExpression, name: string): boolean {
  return lit.properties.some(
    (p) =>
      (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
      p.name &&
      ts.isIdentifier(p.name) &&
      p.name.text === name,
  )
}

function readStringProp(lit: ts.ObjectLiteralExpression, name: string): string | undefined {
  for (const p of lit.properties) {
    if (
      ts.isPropertyAssignment(p) &&
      ts.isIdentifier(p.name) &&
      p.name.text === name &&
      ts.isStringLiteralLike(p.initializer)
    ) {
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
    : (checker as unknown as { getTypeOfSymbol?: (s: ts.Symbol) => ts.Type }).getTypeOfSymbol?.(sym)
  if (!t) return undefined
  return tsTypeToJsonSchema(t, { checker })
}

function extractResources(
  _checker: ts.TypeChecker,
  routes: FlatRoute[],
  _routesSourceFile: ts.SourceFile | undefined,
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
