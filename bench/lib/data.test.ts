import { expect, test } from 'bun:test'
import { join } from 'node:path'
import data from '../apps/_shared/data.json'
import { buildData } from '../apps/_shared/gen-data'

test('data.json: 151 rows in dex order, 18 types, derived fields', () => {
  expect(data.pokemon).toHaveLength(151)
  expect(data.pokemon[0]).toEqual({ id: 1, name: 'bulbasaur', displayName: 'Bulbasaur', num: '#0001', types: ['grass', 'poison'] })
  expect(data.pokemon[150]?.num).toBe('#0151')
  expect(data.types).toHaveLength(18)
  expect(data.types[0]).toEqual({ name: 'normal', label: 'Normal', tint: '#9099a1' })
  expect(data.types[3]).toEqual({ name: 'electric', label: 'Electric', tint: '#f5c84b' })
})

test('the committed file is the generator output (regenerate with `bun bench/apps/_shared/gen-data.ts`)', async () => {
  const snap = await Bun.file(join(import.meta.dir, '../../examples/pokedex/data/pokedex.json')).json()
  expect(buildData(snap)).toEqual(data)
})
