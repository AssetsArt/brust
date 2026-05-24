import ts from 'typescript'
import { tsTypeToJsonSchema, type JsonSchema } from './schema.ts'
import type { McpManifest, ToolSchema, ResourceSchema } from './manifest.ts'
import type { ActionDef } from '../actions.ts'
import type { FlatRoute } from '../routes.ts'

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
      strictNullChecks: true,
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
  if (
    ts.isFunctionDeclaration(node) &&
    node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
    node.name
  ) {
    const name = node.name.text
    if (!actionIds.has(name)) return null
    return toolFromSignature(checker, name, node.parameters, node.type, getJsdoc(node))
  }
  // Case 2: export const name = withMiddleware([...], async (req, ...args) => ...)
  if (
    ts.isVariableStatement(node) &&
    node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  ) {
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
