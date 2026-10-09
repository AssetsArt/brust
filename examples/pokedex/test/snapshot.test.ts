// examples/pokedex/test/snapshot.test.ts
import { expect, test } from 'bun:test'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import snap from '../data/pokedex.json'
import { ALL_TYPES, fetchEvolution, fetchPokemon, fetchSpecies, fetchTypeRelations } from '../lib/pokeapi'

test('snapshot: 151 Pokémon in dex order, 18 type relations, under 600 KB', () => {
  expect(snap.pokemon).toHaveLength(151)
  expect(snap.pokemon.map((p) => p.id)).toEqual(Array.from({ length: 151 }, (_, i) => i + 1))
  expect(Object.keys(snap.types).sort()).toEqual([...ALL_TYPES].sort())
  expect(statSync(join(import.meta.dir, '../data/pokedex.json')).size).toBeLessThan(600 * 1024)
})

test('pikachu reads from the snapshot with the 0.1.x shapes', async () => {
  const p = await fetchPokemon('pikachu')
  expect(p).toMatchObject({ id: 25, name: 'pikachu', types: ['electric'] })
  expect(p!.stats.map((s) => s.name)).toEqual(['hp', 'attack', 'defense', 'special-attack', 'special-defense', 'speed'])
  const s = await fetchSpecies(25)
  expect(s.genus).toBe('Mouse Pokémon')
  expect(await fetchEvolution(s.evolutionUrl)).toEqual([{ id: 172, name: 'pichu', minLevel: null }, { id: 25, name: 'pikachu', minLevel: null }, { id: 26, name: 'raichu', minLevel: null }])
  expect(await fetchTypeRelations('electric')).toMatchObject({ water: 2, flying: 2, ground: 0, grass: 0.5 })
  expect(await fetchPokemon('nothing')).toBeNull()
})
