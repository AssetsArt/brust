// website/lib/pokemon.ts — the one Pokémon data module for the site: a curated Gen-1 set and the PokeAPI image URLs.
// Images are hot-linked from PokeAPI's sprite repo, never committed (artwork © Nintendo / Game Freak).

export type PokemonType =
  | 'normal' | 'fire' | 'water' | 'electric' | 'grass' | 'ice' | 'poison' | 'flying' | 'psychic' | 'ghost' | 'dragon' | 'fairy'

export interface Pokemon {
  id: number
  name: string
  types: PokemonType[]
}

/** 24 Gen-1 Pokémon, in Pokédex order. */
export const POKEMON: readonly Pokemon[] = [
  { id: 1, name: 'bulbasaur', types: ['grass', 'poison'] },
  { id: 2, name: 'ivysaur', types: ['grass', 'poison'] },
  { id: 3, name: 'venusaur', types: ['grass', 'poison'] },
  { id: 4, name: 'charmander', types: ['fire'] },
  { id: 5, name: 'charmeleon', types: ['fire'] },
  { id: 6, name: 'charizard', types: ['fire', 'flying'] },
  { id: 7, name: 'squirtle', types: ['water'] },
  { id: 8, name: 'wartortle', types: ['water'] },
  { id: 9, name: 'blastoise', types: ['water'] },
  { id: 25, name: 'pikachu', types: ['electric'] },
  { id: 26, name: 'raichu', types: ['electric'] },
  { id: 39, name: 'jigglypuff', types: ['normal', 'fairy'] },
  { id: 54, name: 'psyduck', types: ['water'] },
  { id: 94, name: 'gengar', types: ['ghost', 'poison'] },
  { id: 129, name: 'magikarp', types: ['water'] },
  { id: 130, name: 'gyarados', types: ['water', 'flying'] },
  { id: 131, name: 'lapras', types: ['water', 'ice'] },
  { id: 133, name: 'eevee', types: ['normal'] },
  { id: 134, name: 'vaporeon', types: ['water'] },
  { id: 135, name: 'jolteon', types: ['electric'] },
  { id: 143, name: 'snorlax', types: ['normal'] },
  { id: 149, name: 'dragonite', types: ['dragon', 'flying'] },
  { id: 150, name: 'mewtwo', types: ['psychic'] },
  { id: 151, name: 'mew', types: ['psychic'] },
]

const SPRITES = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon'

/** Official artwork, 475×475 PNG. */
export const artworkUrl = (id: number): string => `${SPRITES}/other/official-artwork/${id}.png`
/** Shiny official artwork, 475×475 PNG. */
export const shinyUrl = (id: number): string => `${SPRITES}/other/official-artwork/shiny/${id}.png`
/** The 96×96 pixel sprite. */
export const spriteUrl = (id: number): string => `${SPRITES}/${id}.png`

/** `25` → `#025`. */
export const dexNo = (id: number): string => `#${String(id).padStart(3, '0')}`
/** `mr-mime` → `Mr Mime`. */
export const displayName = (name: string): string => name.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')

export const byId = (id: number): Pokemon | undefined => POKEMON.find((p) => p.id === id)
export const byName = (name: string): Pokemon | undefined => POKEMON.find((p) => p.name === name.toLowerCase())

/** Case-insensitive name or number match; an empty query returns every Pokémon. */
export function search(query: string): Pokemon[] {
  const q = query.trim().toLowerCase().replace(/^#/, '')
  if (!q) return [...POKEMON]
  return POKEMON.filter((p) => p.name.includes(q) || String(p.id).padStart(3, '0').includes(q))
}
