// Route loaders. Each runs in a Bun worker (full JS), and returns a fully
// render-ready view-model. SLICE 1: these are STUBS — they return the chrome
// fields every page needs (title / crumb / mode / teamProps) plus the minimal
// data each stub page interpolates. Real PokeAPI-backed data lands in later
// slices.

import { type BrustRequest, type NativeVerdict, notFound } from 'brustjs/routes'
import {
  ALL_TYPES,
  artwork,
  cap,
  fetchEvolution,
  fetchList,
  fetchPokemon,
  fetchSpecies,
  fetchTypeRelations,
  pad,
  STAT_LABEL,
  statBucket,
  TYPE_COLOR,
} from './pokeapi'
import { teamStore } from './team-store'
import type {
  BrowseData,
  DetailData,
  HomeData,
  TypeBadgeVM,
  TypeChartCellVM,
  TypeChartData,
  TypeChartRowVM,
} from './types'

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

/** Base-stat bucket → bar fill hex. Bucket order: hi / mid / low / min. */
const BAR_COLOR: Record<string, string> = {
  hi: '#16a34a', // green-600
  mid: '#0ea5e9', // sky-500
  low: '#f59e0b', // amber-500
  min: '#ef4444', // red-500
}

const typeBadge = (t: string): TypeBadgeVM => ({
  label: cap(t),
  color: TYPE_COLOR[t] ?? '#888888',
})

export async function detailLoader({
  params,
  req,
}: LoaderCtx): Promise<DetailData | NativeVerdict> {
  const name = params?.name ?? ''
  const empty = emptyDetail(req, name)

  const p = await fetchPokemon(name)
  // Native loaders can `return notFound(data)` to render THIS route's own
  // template with HTTP 404. The `notFound: true` flag on `empty` drives the
  // template's 404-block branch; the sentinel sets the HTTP STATUS.
  if (!p) return notFound(empty)

  const species = await fetchSpecies(p.id)
  // A native route renders in Rust with no React tree, so <Suspense> streaming
  // is impossible — the evolution chain (the slow fetch) is loaded BLOCKING here.
  const rawEvo = await fetchEvolution(species.evolutionUrl)

  const primary = p.types[0] ?? 'normal'
  const tint = TYPE_COLOR[primary] ?? '#888888'

  const stats = p.stats.map((s) => {
    const pct = Math.min(100, Math.round((s.base / 200) * 100))
    const bucket = statBucket(s.base)
    return {
      label: STAT_LABEL[s.name] ?? s.name,
      base: s.base,
      barWidth: `${pct}%`,
      barColor: BAR_COLOR[bucket] ?? '#0ea5e9',
    }
  })

  const abilities = p.abilities.map((a) => ({
    displayName: cap(a),
    initial: a.charAt(0).toUpperCase(),
    iconColor: tint,
  }))

  const evolution = rawEvo.map((s, i) => ({
    id: s.id,
    displayName: cap(s.name),
    num: pad(s.id),
    artwork: artwork(s.id),
    detailHref: `/pokemon/${s.name}`,
    levelLabel: s.minLevel != null ? `Lv ${s.minLevel}` : '',
    isFirst: i === 0,
    showLevel: i > 0 && s.minLevel != null,
    isCurrent: s.id === p.id,
  }))

  return {
    ...chrome(req, `${cap(p.name)} · PokéDex`, cap(p.name)),
    notFound: false,
    name: p.name,
    id: p.id,
    displayName: cap(p.name),
    num: pad(p.id),
    artwork: p.artwork,
    genus: species.genus,
    flavorText: species.flavorText,
    heightLabel: `${(p.height / 10).toFixed(1)} m`,
    weightLabel: `${(p.weight / 10).toFixed(1)} kg`,
    abilityCount: p.abilities.length,
    // Loaders are full JS — template literals are fine HERE (the constraint is
    // on the native template body only). Brand-tinted hero gradient.
    heroBg: `linear-gradient(160deg, ${tint}33, transparent 70%)`,
    types: p.types.map(typeBadge),
    stats,
    statTotal: p.stats.reduce((a, s) => a + s.base, 0),
    abilities,
    hasAbilities: abilities.length > 0,
    evolution,
    hasEvolution: evolution.length > 1,
    // Native templates can't call JSON.stringify, so precompute the x-props JSON
    // here. AddToTeamButton's prop contract is unchanged.
    addProps: JSON.stringify({
      id: p.id,
      name: p.name,
      displayName: cap(p.name),
      num: pad(p.id),
      types: p.types,
      artwork: p.artwork,
    }),
  }
}

function emptyDetail(req: BrustRequest, name: string): DetailData {
  return {
    ...chrome(req, `${cap(name)} · PokéDex`, cap(name)),
    notFound: true,
    name,
    id: 0,
    displayName: cap(name),
    num: '',
    artwork: '',
    genus: '',
    flavorText: '',
    heightLabel: '',
    weightLabel: '',
    abilityCount: 0,
    heroBg: '',
    types: [],
    stats: [],
    statTotal: 0,
    abilities: [],
    hasAbilities: false,
    evolution: [],
    hasEvolution: false,
    addProps: JSON.stringify({
      id: 0,
      name,
      displayName: cap(name),
      num: '',
      types: [],
      artwork: '',
    }),
  }
}

const SHORT: Record<string, string> = {
  normal: 'NOR',
  fire: 'FIR',
  water: 'WAT',
  electric: 'ELE',
  grass: 'GRA',
  ice: 'ICE',
  fighting: 'FIG',
  poison: 'POI',
  ground: 'GRO',
  flying: 'FLY',
  psychic: 'PSY',
  bug: 'BUG',
  rock: 'ROC',
  ghost: 'GHO',
  dragon: 'DRA',
  dark: 'DAR',
  steel: 'STE',
  fairy: 'FAI',
}

// Effectiveness → static Tailwind utility class string. These are literals in a
// .ts file scanned by `@source`, so the scanner sees every class. The header /
// row-head / corner / data cells share a base sizing class.
const CELL_BASE =
  'flex items-center justify-center text-xs font-semibold tabular-nums aspect-square'
const HEAD_BASE =
  'flex items-center justify-center text-[10px] font-bold uppercase tracking-tight text-white aspect-square'
const CELL_CLASS: Record<string, string> = {
  super: `${CELL_BASE} bg-green-500/25 text-green-700 dark:text-green-300`,
  weak: `${CELL_BASE} bg-red-500/20 text-red-700 dark:text-red-300`,
  none: `${CELL_BASE} bg-slate-800/80 text-slate-200`,
  normal: `${CELL_BASE} text-slate-300 dark:text-slate-600`,
}

export async function typeChartLoader({ req }: LoaderCtx): Promise<TypeChartData> {
  // Fan out 18 type fetches; each goes through cachedFetch so duplicate in-flight
  // GETs within the request dedupe.
  const relations = await Promise.all(ALL_TYPES.map((t) => fetchTypeRelations(t)))

  // Build the 19×19 grid as nested rows (header row + one row per attacking
  // type). The native template renders it with nested `.map()`.
  const rows: TypeChartRowVM[] = []

  const headerCells: TypeChartCellVM[] = [
    {
      id: '0-0',
      className: `${HEAD_BASE} sticky left-0 top-0 z-20 text-[9px]`,
      content: 'ATK／DEF',
      title: 'Attacking ／ Defending',
      bg: '#334155', // slate-700
    },
  ]
  ALL_TYPES.forEach((def, j) => {
    headerCells.push({
      id: `0-${j + 1}`,
      className: `${HEAD_BASE} sticky top-0 z-10`,
      content: SHORT[def] ?? def.slice(0, 3).toUpperCase(),
      title: cap(def),
      bg: TYPE_COLOR[def] ?? '#888888',
    })
  })
  rows.push({ id: '0', cells: headerCells })

  ALL_TYPES.forEach((atk, i) => {
    const rel = relations[i] ?? {}
    const rowCells: TypeChartCellVM[] = [
      {
        id: `${i + 1}-0`,
        className: `${HEAD_BASE} sticky left-0 z-10`,
        content: SHORT[atk] ?? atk.slice(0, 3).toUpperCase(),
        title: cap(atk),
        bg: TYPE_COLOR[atk] ?? '#888888',
      },
    ]
    ALL_TYPES.forEach((def, j) => {
      const mult = rel[def]
      const id = `${i + 1}-${j + 1}`
      if (mult === 2)
        rowCells.push({
          id,
          className: CELL_CLASS.super!,
          content: '2',
          title: `${cap(atk)} → ${cap(def)}: 2× (super effective)`,
          bg: '',
        })
      else if (mult === 0.5)
        rowCells.push({
          id,
          className: CELL_CLASS.weak!,
          content: '½',
          title: `${cap(atk)} → ${cap(def)}: ½× (not very effective)`,
          bg: '',
        })
      else if (mult === 0)
        rowCells.push({
          id,
          className: CELL_CLASS.none!,
          content: '0',
          title: `${cap(atk)} → ${cap(def)}: 0× (no effect)`,
          bg: '',
        })
      else
        rowCells.push({
          id,
          className: CELL_CLASS.normal!,
          content: '',
          title: `${cap(atk)} → ${cap(def)}: 1×`,
          bg: '',
        })
    })
    rows.push({ id: String(i + 1), cells: rowCells })
  })

  return {
    ...chrome(req, 'PokéDex · type chart', 'Type chart'),
    rows,
  }
}
