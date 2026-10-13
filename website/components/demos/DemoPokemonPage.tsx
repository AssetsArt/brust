// The demo route /demo/pokemon/{name} (routes.tsx demo block): a route param read by a loader, cached in L1 for
// 60 s under the tag `pokemon`, `?nocache=1` bypasses. The Caching and Loaders docs pages link it; the static export
// writes one page per lib/pokemon.ts entry (plan R3).
import { type LoaderCtx, notFound, type Verdict } from '@brust/core/routes'
import { artworkUrl, byName, dexNo, displayName } from '../../lib/pokemon'
import PokemonCard from '../landing/demos/PokemonCard'

export interface DemoPokemonData {
  title: string
  pokemon: { no: string; name: string; art: string; types: string[] }
  served: string
}

export async function demoPokemonLoader({ params }: LoaderCtx<{ name: string }>): Promise<DemoPokemonData | Verdict> {
  const p = byName(params.name ?? '')
  if (!p) return notFound({ title: 'Unknown Pokémon · brust', pokemon: { no: '#???', name: params.name ?? '', art: '', types: [] }, served: '' })
  return {
    title: `${displayName(p.name)} · brust demo`,
    pokemon: { no: dexNo(p.id), name: displayName(p.name), art: artworkUrl(p.id), types: p.types },
    served: new Date().toISOString(),
  }
}

export default function DemoPokemonPage({ pokemon, served }: DemoPokemonData) {
  return (
    <section className="wrap demo-page">
      <p className="crumbs">GET /demo/pokemon/{'{name}'}</p>
      <div className="cards">
        <PokemonCard no={pokemon.no} name={pokemon.name} art={pokemon.art} types={pokemon.types} />
      </div>
      <p className="muted">
        Rendered by the loader at <code>{served}</code>. A cached response repeats this time until the entry expires.
      </p>
    </section>
  )
}
