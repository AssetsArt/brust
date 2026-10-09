import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { compileTree } from '../native/index.js'

const repo = resolve(import.meta.dir, '../../..')

test('compileTree lowers a fixture and returns IR JSON + artifacts', () => {
  const t = compileTree('tests/fixtures/keyed-list-child-job/input.tsx', repo, 'brust/runtime-dom', [])
  expect(t.error).toBeUndefined()
  expect(t.components.map((c) => c.id)).toEqual(['input_7833a2e1', 'priceRow_845bcd56'])
  const ir = JSON.parse(t.components[0]!.ir)
  expect(ir.instances[0]).toEqual({ child_id: 'priceRow_845bcd56', k: 1, loops: ['items'], props: { item: 'items[idx]', unit: 'unit' } })
  expect(t.components[1]!.serverTs).toContain('export function precompute')
  expect(t.components[0]!.clientJs).toContain('from "brust/runtime-dom"')
})
