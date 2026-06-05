// PokeAPI fetch wrappers + formatting helpers.
//
// These run inside route LOADERS (plain Bun/JS — full language, no native
// constraint). Their job is to fetch from PokeAPI and return fully render-ready
// view-models so the native (jinja) page templates only interpolate fields.

import { cachedFetch } from 'brustjs'

export const API = 'https://pokeapi.co/api/v2'

// Process-lifetime memo of PokeAPI JSON. `cachedFetch` dedupes only WITHIN one
// request (it's AsyncLocalStorage-scoped), so on its own EVERY request re-hits
// pokeapi.co over the network (~700 ms) — at 120 conns `/pokedex` collapses to
// ~170 rps, bound entirely by that round-trip. PokeAPI is IMMUTABLE reference
// data, so the parsed JSON is cached for the process lifetime here: the first
// request warms it, every later request renders from memory. Only successful
// (2xx) responses are cached; a non-ok response or a network error resolves
// `null` and is NOT cached, so a transient 429/500 or a typo'd name retries.
// (Per-request personalization — theme cookie, team — lives in `chrome()`, not
// here, so it is never cached.)
const jsonCache = new Map<string, Promise<unknown>>()

async function getJson<T>(url: string): Promise<T | null> {
  const hit = jsonCache.get(url) as Promise<T | null> | undefined
  if (hit) return hit
  const p = (async (): Promise<T | null> => {
    const res = await cachedFetch(url)
    if (!res.ok) return null
    return (await res.json()) as T
  })()
  jsonCache.set(url, p)
  // Evict anything that didn't yield cacheable data (null / rejected) so the
  // next request can retry rather than memoizing a transient failure forever.
  p.then(
    (v) => {
      if (v === null && jsonCache.get(url) === p) jsonCache.delete(url)
    },
    () => {
      if (jsonCache.get(url) === p) jsonCache.delete(url)
    },
  )
  return p
}

export const idFromUrl = (url: string): number => Number((url.match(/\/pokemon\/(\d+)\//) || [])[1])

/** Official-artwork PNG from the PokeAPI sprites CDN — derived from id so the
 *  list page needs ONE PokeAPI call per page (no per-Pokémon detail fetch). */
export const artwork = (id: number): string =>
  `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${id}.png`

export const cap = (s: string): string =>
  s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/-/g, ' ') : s

export const pad = (n: number): string => `#${String(n).padStart(4, '0')}`

/** Pokémon type → real hex color. Tailwind's scanner can't see runtime-built
 *  class strings, so type tints are applied as inline `style` values from the
 *  loader using these hexes. */
export const TYPE_COLOR: Record<string, string> = {
  normal: '#9099a1',
  fire: '#ef7444',
  water: '#4d90d5',
  grass: '#63bb5b',
  electric: '#f5c84b',
  ice: '#74cec0',
  fighting: '#ce4069',
  poison: '#ab6ac8',
  ground: '#d97746',
  flying: '#8fa8dd',
  psychic: '#f06fa0',
  bug: '#90c12c',
  rock: '#c7b78b',
  ghost: '#5269ac',
  dragon: '#0a6dc4',
  dark: '#5a5366',
  steel: '#5a8ea1',
  fairy: '#ec8fe6',
}

export const STAT_LABEL: Record<string, string> = {
  hp: 'HP',
  attack: 'Atk',
  defense: 'Def',
  'special-attack': 'Sp.Atk',
  'special-defense': 'Sp.Def',
  speed: 'Spd',
}

/** Bucket a base stat into one of three fill modifier classes. */
export const statBucket = (base: number): string =>
  base >= 100 ? 'hi' : base >= 60 ? 'mid' : base >= 35 ? 'low' : 'min'

export interface RawPokemon {
  id: number
  name: string
  types: string[]
  stats: { name: string; base: number }[]
  height: number
  weight: number
  abilities: string[]
  artwork: string
}

export interface RawSpecies {
  flavorText: string
  genus: string
  evolutionUrl: string
}

export interface RawEvolutionStage {
  id: number
  name: string
  minLevel: number | null
}

export async function fetchList(offset: number, limit: number) {
  const page = await getJson<{
    count: number
    results: { name: string; url: string }[]
  }>(`${API}/pokemon?limit=${limit}&offset=${offset}`)
  if (!page) throw new Error('PokeAPI list fetch failed')
  return {
    results: page.results.map((r) => ({ id: idFromUrl(r.url), name: r.name })),
    total: page.count,
  }
}

export async function fetchPokemon(name: string): Promise<RawPokemon | null> {
  const p = await getJson<any>(`${API}/pokemon/${name}`)
  if (!p) return null
  return {
    id: p.id,
    name: p.name,
    types: p.types.map((t: any) => t.type.name),
    stats: p.stats.map((s: any) => ({ name: s.stat.name, base: s.base_stat })),
    height: p.height,
    weight: p.weight,
    abilities: p.abilities.map((a: any) => a.ability.name),
    artwork: p.sprites?.other?.['official-artwork']?.front_default || artwork(p.id),
  }
}

export async function fetchSpecies(id: number): Promise<RawSpecies> {
  const s = await getJson<any>(`${API}/pokemon-species/${id}`)
  if (!s) return { flavorText: '', genus: '', evolutionUrl: '' }
  const flavor = s.flavor_text_entries?.find((e: any) => e.language.name === 'en')?.flavor_text as
    | string
    | undefined
  return {
    flavorText: (flavor || '').replace(/[\n\f\r]+/g, ' ').trim(),
    genus: s.genera?.find((g: any) => g.language.name === 'en')?.genus || '',
    evolutionUrl: s.evolution_chain?.url || '',
  }
}

/** Walk the (linear) evolution chain. Branching chains (e.g. Eevee) are
 *  flattened to the first branch — noted as an open question in the design. */
export async function fetchEvolution(url: string): Promise<RawEvolutionStage[]> {
  if (!url) return []
  const data = await getJson<any>(url)
  if (!data) return []
  const stages: RawEvolutionStage[] = []
  let node = data.chain
  while (node) {
    const id = idFromUrl(node.species.url.replace('-species', ''))
    const det = node.evolution_details?.[0] || {}
    stages.push({ id, name: node.species.name, minLevel: det.min_level || null })
    node = node.evolves_to?.[0]
  }
  return stages
}

/** The 18 canonical type names, in chart order. */
export const ALL_TYPES = [
  'normal',
  'fire',
  'water',
  'electric',
  'grass',
  'ice',
  'fighting',
  'poison',
  'ground',
  'flying',
  'psychic',
  'bug',
  'rock',
  'ghost',
  'dragon',
  'dark',
  'steel',
  'fairy',
]

/** Fetch one type's damage relations → a map of defendingType → multiplier. */
export async function fetchTypeRelations(type: string): Promise<Record<string, number>> {
  const d = await getJson<any>(`${API}/type/${type}`)
  if (!d) return {}
  const rel = d.damage_relations
  const out: Record<string, number> = {}
  for (const t of rel.double_damage_to || []) out[t.name] = 2
  for (const t of rel.half_damage_to || []) out[t.name] = 0.5
  for (const t of rel.no_damage_to || []) out[t.name] = 0
  return out
}
