// The demo components' data, from lib/pokemon.ts (the one Pokémon module): three cards, the Pikachu catch card, and the search list.
import { artworkUrl, byId, dexNo, displayName, POKEMON, shinyUrl, spriteUrl } from '../../lib/pokemon'

export interface CardData {
  no: string
  name: string
  types: string[]
  art: string
}
export interface CatchData {
  no: string
  name: string
  art: string
  shinyArt: string
}
export interface SearchItem {
  id: number
  no: string
  label: string
  name: string
  sprite: string
}

function card(id: number): CardData {
  const p = byId(id)
  if (!p) throw new Error(`lib/pokemon.ts has no #${id}`)
  return { no: dexNo(p.id), name: displayName(p.name), types: [...p.types], art: artworkUrl(p.id) }
}

export function demoData(): { a: CardData; b: CardData; c: CardData; catchData: CatchData; all: SearchItem[] } {
  return {
    a: card(1),
    b: card(4),
    c: card(25),
    catchData: { no: dexNo(25), name: 'Pikachu', art: artworkUrl(25), shinyArt: shinyUrl(25) },
    all: POKEMON.map((p) => ({ id: p.id, no: dexNo(p.id), label: displayName(p.name), name: p.name, sprite: spriteUrl(p.id) })),
  }
}
