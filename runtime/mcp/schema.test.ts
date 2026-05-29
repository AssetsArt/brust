import { test, expect } from 'bun:test'
import ts from 'typescript'
import { tsTypeToJsonSchema } from './schema.ts'

function typeOf(source: string, varName: string): { type: ts.Type; checker: ts.TypeChecker } {
  const fileName = 'test.ts'
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true)
  const host = ts.createCompilerHost({})
  const orig = host.getSourceFile
  host.getSourceFile = (fn, ...rest) =>
    fn === fileName ? sourceFile : orig.call(host, fn, ...rest)
  const program = ts.createProgram({
    rootNames: [fileName],
    options: { noEmit: true, target: ts.ScriptTarget.ES2022, skipLibCheck: true },
    host,
  })
  const checker = program.getTypeChecker()
  const decl = sourceFile.statements.find((s): s is ts.VariableStatement =>
    ts.isVariableStatement(s),
  )!
  const v = decl.declarationList.declarations.find(
    (d) => (d.name as ts.Identifier).text === varName,
  )!
  return { type: checker.getTypeAtLocation(v), checker }
}

test('schema: string primitive', () => {
  const { type, checker } = typeOf('const x: string = ""', 'x')
  expect(tsTypeToJsonSchema(type, { checker })).toEqual({ type: 'string' })
})

test('schema: number primitive', () => {
  const { type, checker } = typeOf('const x: number = 0', 'x')
  expect(tsTypeToJsonSchema(type, { checker })).toEqual({ type: 'number' })
})

test('schema: boolean primitive', () => {
  const { type, checker } = typeOf('const x: boolean = false', 'x')
  expect(tsTypeToJsonSchema(type, { checker })).toEqual({ type: 'boolean' })
})

test('schema: null', () => {
  const { type, checker } = typeOf('const x: null = null', 'x')
  expect(tsTypeToJsonSchema(type, { checker })).toEqual({ type: 'null' })
})

test('schema: string literal', () => {
  const { type, checker } = typeOf('const x: "hello" = "hello"', 'x')
  expect(tsTypeToJsonSchema(type, { checker })).toEqual({ type: 'string', enum: ['hello'] })
})

test('schema: array of strings', () => {
  const { type, checker } = typeOf('const x: string[] = []', 'x')
  expect(tsTypeToJsonSchema(type, { checker })).toEqual({
    type: 'array',
    items: { type: 'string' },
  })
})

test('schema: tuple', () => {
  const { type, checker } = typeOf('const x: [string, number] = ["", 0]', 'x')
  expect(tsTypeToJsonSchema(type, { checker })).toEqual({
    type: 'array',
    prefixItems: [{ type: 'string' }, { type: 'number' }],
    minItems: 2,
    maxItems: 2,
  })
})

test('schema: object with required + optional', () => {
  const { type, checker } = typeOf('const x: { a: string, b?: number } = { a: "" }', 'x')
  expect(tsTypeToJsonSchema(type, { checker })).toEqual({
    type: 'object',
    properties: { a: { type: 'string' }, b: { type: 'number' } },
    required: ['a'],
  })
})

test('schema: nested object', () => {
  const { type, checker } = typeOf('const x: { a: { b: string } } = { a: { b: "" } }', 'x')
  expect(tsTypeToJsonSchema(type, { checker })).toEqual({
    type: 'object',
    properties: { a: { type: 'object', properties: { b: { type: 'string' } }, required: ['b'] } },
    required: ['a'],
  })
})

test('schema: union string | number', () => {
  const { type, checker } = typeOf('const x: string | number = ""', 'x')
  expect(tsTypeToJsonSchema(type, { checker })).toEqual({
    anyOf: [{ type: 'string' }, { type: 'number' }],
  })
})

test('schema: Record<string, number>', () => {
  const { type, checker } = typeOf('const x: Record<string, number> = {}', 'x')
  expect(tsTypeToJsonSchema(type, { checker })).toEqual({
    type: 'object',
    additionalProperties: { type: 'number' },
  })
})

test('schema: Promise<T> unwraps', () => {
  const { type, checker } = typeOf('const x: Promise<string> = Promise.resolve("")', 'x')
  expect(tsTypeToJsonSchema(type, { checker, unwrapPromise: true })).toEqual({ type: 'string' })
})

test('schema: Promise<void> → undefined', () => {
  const { type, checker } = typeOf('const x: Promise<void> = Promise.resolve()', 'x')
  expect(tsTypeToJsonSchema(type, { checker, unwrapPromise: true })).toBeUndefined()
})

test('schema: any → {} (any)', () => {
  const { type, checker } = typeOf('const x: any = 0', 'x')
  expect(tsTypeToJsonSchema(type, { checker })).toEqual({})
})

test('schema: Date → string date-time', () => {
  const { type, checker } = typeOf('const x: Date = new Date()', 'x')
  expect(tsTypeToJsonSchema(type, { checker })).toEqual({ type: 'string', format: 'date-time' })
})

test('schema: tuple with optional trailing element', () => {
  const { type, checker } = typeOf('const x: [string, number?] = [""]', 'x')
  expect(tsTypeToJsonSchema(type, { checker })).toEqual({
    type: 'array',
    prefixItems: [{ type: 'string' }, { type: 'number' }],
    minItems: 1,
    maxItems: 2,
  })
})
