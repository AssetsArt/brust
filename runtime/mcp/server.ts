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
