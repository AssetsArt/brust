import { expect, test } from 'bun:test'
import { parseValue } from '../src/value'

test('parseValue grammar', () => {
  expect(parseValue('label')).toEqual({ path: ['label'], bindings: [] })
  expect(parseValue('a.b.c')).toEqual({ path: ['a', 'b', 'c'], bindings: [] })
  expect(parseValue('_h2:item')).toEqual({ path: ['_h2'], bindings: ['item'] })
  expect(parseValue('_c1:item,index')).toEqual({ path: ['_c1'], bindings: ['item', 'index'] })
  expect(parseValue('x + 1')).toBeNull()
  expect(parseValue('fn()')).toBeNull()
})
