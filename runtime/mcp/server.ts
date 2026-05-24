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

export function makeResult(id: number | string | null, result: unknown): string {
  const resp: JsonRpcSuccess<unknown> = { jsonrpc: '2.0', id, result }
  return JSON.stringify(resp)
}

export function makeError(id: number | string | null, code: number, message: string): string {
  const resp: JsonRpcError = { jsonrpc: '2.0', id, error: { code, message } }
  return JSON.stringify(resp)
}
