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
    if (inner === null) return undefined         // Promise<void>
    if (inner !== undefined) return tsTypeToJsonSchema(inner, { ...opts, unwrapPromise: false })
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
  // Array / Tuple / Object
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
    // Object: enumerate properties (or Record-like via string index signature)
    if (flags & ts.TypeFlags.Object) {
      const props = type.getProperties()
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
  // Fallback: any (loses info but agent still works)
  return {}
}

function unwrapPromise(type: ts.Type, checker?: ts.TypeChecker): ts.Type | null | undefined {
  // Returns: ts.Type unwrapped; null = unwrap result is void; undefined = not a Promise.
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
