// Route loaders. Each runs in a Bun worker (full JS), and returns a fully
// render-ready view-model. SLICE 1: these are STUBS — they return the chrome
// fields every page needs (title / crumb / mode / teamProps) plus the minimal
// data each stub page interpolates. Real PokeAPI-backed data lands in later
// slices.

import type { BrustRequest } from 'brustjs/routes'
import { ALL_TYPES, artwork, cap, fetchList, pad, TYPE_COLOR } from './pokeapi'
import { teamStore } from './team-store'
import type { BrowseData, DetailData, HomeData, TypeChartData } from './types'

/** A curated set of iconic Pokémon for the home featured strip. Hardcoded
 *  {id,name} so the home page needs ZERO PokeAPI calls — artwork is derived from
 *  id, names supply the display label and detail href. */
const FEATURED: { id: number; name: string }[] = [
  { id: 1, name: 'bulbasaur' },
  { id: 4, name: 'charmander' },
  { id: 7, name: 'squirtle' },
  { id: 25, name: 'pikachu' },
  { id: 39, name: 'jigglypuff' },
  { id: 94, name: 'gengar' },
  { id: 143, name: 'snorlax' },
  { id: 150, name: 'mewtwo' },
]

interface LoaderCtx {
  params: Record<string, string>
  path: string
  req: BrustRequest
}

const chrome = (req: BrustRequest, title: string, crumb: string) => ({
  title,
  crumb,
  mode: (req.cookies.mode === 'light' ? 'light' : 'dark') as 'light' | 'dark',
  teamProps: { teamInitial: teamStore.list() },
})

export async function homeLoader({ req }: LoaderCtx): Promise<HomeData> {
  const featured = FEATURED.map((p) => ({
    id: p.id,
    name: p.name,
    displayName: cap(p.name),
    num: pad(p.id),
    artwork: artwork(p.id),
    detailHref: `/pokemon/${p.name}`,
  }))
  const typeTiles = ALL_TYPES.map((t) => ({
    name: t,
    label: cap(t),
    color: TYPE_COLOR[t] ?? '#888888',
    href: '/pokedex',
  }))
  return {
    ...chrome(req, 'PokéDex · built with brust', 'Home'),
    featured,
    typeTiles,
  }
}

export async function browseLoader({ req }: LoaderCtx): Promise<BrowseData> {
  const { results } = await fetchList(0, 151)
  const items = results.map((r) => ({
    id: r.id,
    name: r.name,
    displayName: cap(r.name),
    num: pad(r.id),
    artwork: artwork(r.id),
    detailHref: `/pokemon/${r.name}`,
  }))
  return {
    ...chrome(req, 'Pokédex · Browse', 'Pokédex'),
    dexProps: JSON.stringify({ items }),
  }
}

export async function detailLoader({ params, req }: LoaderCtx): Promise<DetailData> {
  const name = params?.name ?? ''
  return {
    ...chrome(req, `${name} · PokéDex`, name),
    notFound: false,
    name,
    displayName: name,
    addProps: JSON.stringify({
      id: 0,
      name,
      displayName: name,
      num: '',
      types: [],
      artwork: '',
    }),
  }
}

export async function typeChartLoader({ req }: LoaderCtx): Promise<TypeChartData> {
  return {
    ...chrome(req, 'PokéDex · type chart', 'Type chart'),
    heading: 'Type chart',
  }
}
