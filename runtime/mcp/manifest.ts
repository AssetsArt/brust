// Task 4 stub — Task 6 will replace this with the read/write implementation,
// add the JsonSchema import, and refine inputSchema/outputSchema typings.
// The field shapes here intentionally match the plan-spec so Tasks 8/9 type-
// check without modification once they consume ToolSchema.paramOrder and
// ResourceSchema.routeIndex.

export interface ToolSchema {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  paramOrder: string[]
}

export interface ResourceSchema {
  uriTemplate: string
  name: string
  description?: string
  outputSchema?: Record<string, unknown>
  routeIndex: number
}

export interface McpManifest {
  version: 1
  tools: ToolSchema[]
  resources: ResourceSchema[]
}
