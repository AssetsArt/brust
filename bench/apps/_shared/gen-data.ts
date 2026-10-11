// bench/apps/_shared/gen-data.ts — derive the bench dataset from the pokedex snapshot (run by hand; output committed).
//   bun bench/apps/_shared/gen-data.ts
import { join } from 'node:path'

export interface TypeRow { name: string; label: string; tint: string }
export interface DexRow { id: number; name: string; displayName: string; num: string; types: string[] }
export interface BenchData { generatedFrom: string; types: TypeRow[]; pokemon: DexRow[] }

/** Same table as examples/pokedex/lib/format.ts `tint` — copied so the bench never imports the example. */
export const TINT: Record<string, string> = { normal: '#9099a1', fire: '#ef7444', water: '#4d90d5', grass: '#63bb5b', electric: '#f5c84b', ice: '#74cec0', fighting: '#ce4069', poison: '#ab6ac8', ground: '#d97746', flying: '#8fa8dd', psychic: '#f06fa0', bug: '#90c12c', rock: '#c7b78b', ghost: '#5269ac', dragon: '#0a6dc4', dark: '#5a5366', steel: '#5a8ea1', fairy: '#ec8fe6' }
export const ALL_TYPES = ['normal', 'fire', 'water', 'electric', 'grass', 'ice', 'fighting', 'poison', 'ground', 'flying', 'psychic', 'bug', 'rock', 'ghost', 'dragon', 'dark', 'steel', 'fairy']
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/-/g, ' ')
const pad = (n: number) => `#${String(n).padStart(4, '0')}`

export function buildData(snap: { pokemon: { id: number; name: string; types: string[] }[] }): BenchData {
  return {
    generatedFrom: 'examples/pokedex/data/pokedex.json',
    types: ALL_TYPES.map((name) => ({ name, label: cap(name), tint: TINT[name] ?? '#888888' })),
    pokemon: snap.pokemon.map((p) => ({ id: p.id, name: p.name, displayName: cap(p.name), num: pad(p.id), types: [...p.types] })),
  }
}

if (import.meta.main) {
  const snap = await Bun.file(join(import.meta.dir, '../../../examples/pokedex/data/pokedex.json')).json()
  const out = join(import.meta.dir, 'data.json')
  await Bun.write(out, `${JSON.stringify(buildData(snap), null, 1)}\n`)
  console.log(`[gen-data] wrote ${out}`)
}
