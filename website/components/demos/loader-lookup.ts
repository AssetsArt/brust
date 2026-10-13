// The Loaders page's `?pokemon=` lookup, shared by the page loader (first paint) and the browser demo (plan R7):
// the same trim, lower-case and 30-character cut, the same lib/pokemon.ts entries.
import { artworkUrl, byName, dexNo, displayName } from '../../lib/pokemon'

export interface Lookup {
  query: string
  found: boolean
  card: { no: string; name: string; art: string; types: string[] }
}

export function lookup(raw: string | null | undefined): Lookup {
  const query = (raw ?? 'pikachu').trim().toLowerCase().slice(0, 30)
  const p = byName(query)
  return {
    query,
    found: p !== undefined,
    card: p
      ? { no: dexNo(p.id), name: displayName(p.name), art: artworkUrl(p.id), types: p.types }
      : { no: '#???', name: query || '(empty)', art: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=', types: [] },
  }
}
