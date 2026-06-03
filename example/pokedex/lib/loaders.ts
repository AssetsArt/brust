// Route loaders. Each runs in a Bun worker (full JS), and returns a fully
// render-ready view-model. SLICE 1: these are STUBS — they return the chrome
// fields every page needs (title / crumb / mode / teamProps) plus the minimal
// data each stub page interpolates. Real PokeAPI-backed data lands in later
// slices.

import type { BrustRequest } from 'brustjs/routes'
import { teamStore } from './team-store'
import type { BrowseData, DetailData, HomeData, TypeChartData } from './types'

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
  return {
    ...chrome(req, 'PokéDex · brust example', 'Home'),
    heading: 'PokéDex',
  }
}

export async function browseLoader({ req }: LoaderCtx): Promise<BrowseData> {
  return {
    ...chrome(req, 'Pokédex · browse', 'Pokédex'),
    heading: 'Browse Pokémon',
    dexProps: JSON.stringify({ items: [] }),
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
