// Unit tests for the public `compileJsx` facade (R1 compile half). Standalone —
// no server spawn (unlike integration.test.ts). Loads the locally-built native
// addon via runtime/index.ts.
import { test, expect } from 'bun:test'
import { compileJsx } from '../runtime/index.ts'

test('compileJsx is public and compiles TSX to auto-escaped jinja', () => {
  const out = compileJsx(
    'export default function H({ settings }: any) { return <h1>{settings.t}</h1> }',
    'test/H',
  )
  expect(out.template).toContain('{{ (settings.t) | e }}')
  expect(out.islandsJson).toBe('[]')
})

test('compileJsx throws on invalid source', () => {
  expect(() => compileJsx('this is not a component', 'test/bad')).toThrow()
})
