// PokeAPI fetch wrappers + formatting helpers.
//
// These run inside route LOADERS (plain Bun/JS — full language, no native
// constraint). Their job is to fetch from PokeAPI and return fully render-ready
// view-models so the native (jinja) page templates only interpolate fields.

export const API = 'https://pokeapi.co/api/v2'

export const idFromUrl = (url: string): number => Number((url.match(/\/pokemon\/(\d+)\//) || [])[1])

/** Official-artwork PNG from the PokeAPI sprites CDN — derived from id so the
 *  list page needs ONE PokeAPI call per page (no per-Pokémon detail fetch). */
export const artwork = (id: number): string =>
  `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${id}.png`

export const cap = (s: string): string =>
  s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/-/g, ' ') : s

export const pad = (n: number): string => `#${String(n).padStart(4, '0')}`

/** Pokémon type → AssetsArt design-token CSS variable (stays inside brand —
 *  no canonical Pokémon colours). Mirrored by `.dex-type--<name>` rules in
 *  app.css. */
export const TYPE_COLOR: Record<string, string> = {
  normal: 'var(--ink-400)',
  fire: 'var(--magenta-500)',
  water: 'var(--blue-500)',
  grass: 'var(--success-500)',
  electric: 'var(--warning-500)',
  ice: 'var(--viz-4)',
  fighting: 'var(--viz-3)',
  poison: 'var(--purple-600)',
  ground: 'var(--viz-7)',
  flying: 'var(--viz-5)',
  psychic: 'var(--purple-500)',
  bug: 'var(--viz-8)',
  rock: 'var(--ink-500)',
  ghost: 'var(--purple-700)',
  dragon: 'var(--viz-2)',
  dark: 'var(--ink-800)',
  steel: 'var(--ink-400)',
  fairy: 'var(--magenta-300)',
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
  const res = await fetch(`${API}/pokemon?limit=${limit}&offset=${offset}`)
  if (!res.ok) throw new Error(`PokeAPI list ${res.status}`)
  const page = (await res.json()) as {
    count: number
    results: { name: string; url: string }[]
  }
  return {
    results: page.results.map((r) => ({ id: idFromUrl(r.url), name: r.name })),
    total: page.count,
  }
}

export async function fetchPokemon(name: string): Promise<RawPokemon | null> {
  const res = await fetch(`${API}/pokemon/${name}`)
  if (!res.ok) return null
  const p = (await res.json()) as any
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
  const res = await fetch(`${API}/pokemon-species/${id}`)
  const s = (await res.json()) as any
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
  const res = await fetch(url)
  if (!res.ok) return []
  const data = (await res.json()) as any
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
  const res = await fetch(`${API}/type/${type}`)
  if (!res.ok) return {}
  const d = (await res.json()) as any
  const rel = d.damage_relations
  const out: Record<string, number> = {}
  for (const t of rel.double_damage_to || []) out[t.name] = 2
  for (const t of rel.half_damage_to || []) out[t.name] = 0.5
  for (const t of rel.no_damage_to || []) out[t.name] = 0
  return out
}
