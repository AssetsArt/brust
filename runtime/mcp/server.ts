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
          return handleToolsList(rpc, opts)
        case 'tools/call':
          return handleToolsCall(rpc, opts, req)
        case 'resources/list':
          return handleResourcesList(rpc, opts)
        case 'resources/read':
          return handleResourcesRead(rpc, opts, req)
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

  // Match against the routes. matchUriPath does the {param} capture that the
  // manifest's pre-computed ResourceSchema.routeIndex cannot do alone — both
  // index spaces stay aligned because the extractor builds resources in the
  // same opts.routes order the server consumes, so a divergence would mean
  // routes were rebuilt without a matching brust.buildMcpManifest call.
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

export function makeResult(id: number | string | null, result: unknown): string {
  const resp: JsonRpcSuccess<unknown> = { jsonrpc: '2.0', id, result }
  return JSON.stringify(resp)
}

export function makeError(id: number | string | null, code: number, message: string): string {
  const resp: JsonRpcError = { jsonrpc: '2.0', id, error: { code, message } }
  return JSON.stringify(resp)
}
