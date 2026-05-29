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
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    throw new Error(`mcp-manifest.json is malformed: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (!parsed || typeof parsed !== 'object' || (parsed as McpManifest).version !== 1) {
    throw new Error(`mcp-manifest.json version mismatch (expected 1)`)
  }
  return parsed as McpManifest
}
