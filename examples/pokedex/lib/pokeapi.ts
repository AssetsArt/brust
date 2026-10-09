// examples/pokedex/lib/pokeapi.ts — the 0.1.x helper surface, served from data/pokedex.json (no network).
import snap from '../data/pokedex.json'

export interface RawPokemon { id: number; name: string; types: string[]; stats: { name: string; base: number }[]; height: number; weight: number; abilities: string[]; artwork: string }
export interface RawSpecies { flavorText: string; genus: string; evolutionUrl: string }
export interface RawEvolutionStage { id: number; name: string; minLevel: number | null }

const byName = new Map(snap.pokemon.map((p) => [p.name, p]))
const byId = new Map(snap.pokemon.map((p) => [p.id, p]))

export const artwork = (id: number): string => byId.get(id)?.artwork ?? `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${id}.png`
export const cap = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/-/g, ' ') : s)
export const pad = (n: number): string => `#${String(n).padStart(4, '0')}`
export const TYPE_COLOR: Record<string, string> = { normal: '#9099a1', fire: '#ef7444', water: '#4d90d5', grass: '#63bb5b', electric: '#f5c84b', ice: '#74cec0', fighting: '#ce4069', poison: '#ab6ac8', ground: '#d97746', flying: '#8fa8dd', psychic: '#f06fa0', bug: '#90c12c', rock: '#c7b78b', ghost: '#5269ac', dragon: '#0a6dc4', dark: '#5a5366', steel: '#5a8ea1', fairy: '#ec8fe6' }
export const STAT_LABEL: Record<string, string> = { hp: 'HP', attack: 'Atk', defense: 'Def', 'special-attack': 'Sp.Atk', 'special-defense': 'Sp.Def', speed: 'Spd' }
export const statBucket = (base: number): string => (base >= 100 ? 'hi' : base >= 60 ? 'mid' : base >= 35 ? 'low' : 'min')
export const ALL_TYPES = ['normal','fire','water','electric','grass','ice','fighting','poison','ground','flying','psychic','bug','rock','ghost','dragon','dark','steel','fairy']

export async function fetchList(offset: number, limit: number) {
  return { results: snap.pokemon.slice(offset, offset + limit).map((p) => ({ id: p.id, name: p.name })), total: snap.pokemon.length }
}
export async function fetchPokemon(name: string): Promise<RawPokemon | null> {
  const p = byName.get(name)
  return p ? { id: p.id, name: p.name, types: p.types, stats: p.stats, height: p.height, weight: p.weight, abilities: p.abilities, artwork: p.artwork } : null
}
/** `evolutionUrl` is the Pokémon id as a string: the key `fetchEvolution` reads (0.1.x carried a URL). */
export async function fetchSpecies(id: number): Promise<RawSpecies> {
  const p = byId.get(id)
  return p ? { flavorText: p.flavorText, genus: p.genus, evolutionUrl: String(id) } : { flavorText: '', genus: '', evolutionUrl: '' }
}
export async function fetchEvolution(key: string): Promise<RawEvolutionStage[]> {
  return key ? (byId.get(Number(key))?.evolution ?? []) : []
}
export async function fetchTypeRelations(type: string): Promise<Record<string, number>> {
  return (snap.types as Record<string, Record<string, number>>)[type] ?? {}
}
