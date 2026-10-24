import { expect, test } from 'bun:test'
import { gate } from './ssr-gate.ts'

const allowed = { 'a-row': { row: 'F1', why: 'known' } }

test('an unexplained diff or server refusal is red', () => {
  expect(gate([{ id: 'x', status: 'differ', detail: 'at token 1' }], {})).toHaveLength(1)
  expect(gate([{ id: 'x', status: 'skip-served', detail: 'boot failed' }], {})).toHaveLength(1)
})

test('an allowlisted diff is green, a fixed one is red until its entry goes', () => {
  expect(gate([{ id: 'a-row', status: 'differ' }], allowed)).toEqual([])
  expect(gate([{ id: 'a-row', status: 'same' }], allowed)[0]).toContain('delete its entry')
  expect(gate([], allowed)[0]).toContain('no such battery row')
})

test('harness skips and matches are green', () => {
  expect(gate([{ id: 'p', status: 'skip-react' }, { id: 'q', status: 'same' }, { id: 'r', status: 'skip-tier' }], {})).toEqual([])
})
