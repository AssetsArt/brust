// Task 4 stub — Task 6 will replace this with the read/write implementation.

export interface ToolSchema {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

export interface ResourceSchema {
  uri: string
  name?: string
  description?: string
  mimeType?: string
}

export interface McpManifest {
  tools?: ToolSchema[]
  resources?: ResourceSchema[]
}
