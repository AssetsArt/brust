// examples/pokedex/lib/loaders.ts
import { type LoaderCtx, type LoaderReq, notFound, type Verdict } from '@brust/core/routes'
import { ALL_TYPES, artwork, cap, fetchEvolution, fetchList, fetchPokemon, fetchSpecies, fetchTypeRelations, pad, STAT_LABEL, statBucket, TYPE_COLOR } from './pokeapi'
import type { BrowseData, DetailData, HomeData, TeamMember, TypeChartCellVM, TypeChartData, TypeChartRowVM } from './types'

const FEATURED = [{ id: 1, name: 'bulbasaur' }, { id: 4, name: 'charmander' }, { id: 7, name: 'squirtle' }, { id: 25, name: 'pikachu' }, { id: 39, name: 'jigglypuff' }, { id: 94, name: 'gengar' }, { id: 143, name: 'snorlax' }, { id: 150, name: 'mewtwo' }]
/** Constant on every page, so the TeamBuilder ssr job is one job-cache entry site-wide (D4). */
export const TEAM_SEED: TeamMember[] = [
  { id: 1, name: 'bulbasaur', displayName: 'Bulbasaur', types: ['grass', 'poison'], artwork: artwork(1), num: '#0001' },
  { id: 4, name: 'charmander', displayName: 'Charmander', types: ['fire'], artwork: artwork(4), num: '#0004' },
]
const NAV = [{ href: '/', label: 'Home' }, { href: '/pokedex', label: 'Pokédex' }, { href: '/type-chart', label: 'Type chart' }]
const card = (p: { id: number; name: string }) => ({ id: p.id, name: p.name, displayName: cap(p.name), num: pad(p.id), artwork: artwork(p.id), detailHref: `/pokemon/${p.name}` })

/** Chrome every leaf returns: AppLayout reads it from the merged loader context (child keys win). */
const chrome = (req: LoaderReq, path: string, title: string, crumb: string) => ({
  title, crumb,
  mode: (req.cookies.mode === 'light' ? 'light' : 'dark') as 'light' | 'dark',
  nav: NAV.map((n) => ({ ...n, active: n.href === path })),
  teamInitial: TEAM_SEED,
})

export async function homeLoader({ req, path }: LoaderCtx): Promise<HomeData> {
  return { ...chrome(req, path, 'PokéDex · built with brust', 'Home'), featured: FEATURED.map(card), types: ALL_TYPES }
}
export async function browseLoader({ req, path }: LoaderCtx): Promise<BrowseData> {
  const q = (req.search.q ?? '').trim().toLowerCase()
  const { results } = await fetchList(0, 151)
  return { ...chrome(req, path, 'Pokédex · Browse', 'Pokédex'), q, items: results.filter((r) => !q || r.name.includes(q)).map(card) }
}
const BAR_COLOR: Record<string, string> = { hi: '#16a34a', mid: '#0ea5e9', low: '#f59e0b', min: '#ef4444' }
export async function detailLoader({ params, req, path }: LoaderCtx<{ name: string }>): Promise<DetailData | Verdict> {
  const name = params.name ?? ''
  const p = await fetchPokemon(name)
  if (!p) return notFound(emptyDetail(req, path, name))
  const species = await fetchSpecies(p.id)
  const evo = await fetchEvolution(species.evolutionUrl)
  const tint = TYPE_COLOR[p.types[0] ?? 'normal'] ?? '#888888'
  return {
    ...chrome(req, path, `${cap(p.name)} · PokéDex`, cap(p.name)),
    notFound: false, name: p.name, id: p.id, displayName: cap(p.name), num: pad(p.id), artwork: p.artwork,
    genus: species.genus, flavorText: species.flavorText,
    height: p.height, weight: p.weight,                       // raw: DetailPage's job formats them (D4)
    typeNames: p.types,                                       // TypeBadge per row (D4)
    heroBg: `linear-gradient(160deg, ${tint}33, transparent 70%)`,
    stats: p.stats.map((s) => ({ label: STAT_LABEL[s.name] ?? s.name, base: s.base, barWidth: `${Math.min(100, Math.round((s.base / 200) * 100))}%`, barColor: BAR_COLOR[statBucket(s.base)] ?? '#0ea5e9' })),
    statTotal: p.stats.reduce((a, s) => a + s.base, 0),
    abilities: p.abilities.map((a) => ({ displayName: cap(a), initial: a.charAt(0).toUpperCase(), iconColor: tint })),
    hasAbilities: p.abilities.length > 0,
    evolution: evo.map((s, i) => ({ id: s.id, displayName: cap(s.name), num: pad(s.id), artwork: artwork(s.id), detailHref: `/pokemon/${s.name}`, levelLabel: s.minLevel != null ? `Lv ${s.minLevel}` : '', isFirst: i === 0, showLevel: i > 0 && s.minLevel != null, isCurrent: s.id === p.id })),
    hasEvolution: evo.length > 1,
    abilityCount: p.abilities.length,
  }
}
function emptyDetail(req: LoaderReq, path: string, name: string): DetailData {
  return { ...chrome(req, path, `${cap(name)} · PokéDex`, cap(name)), notFound: true, name, id: 0, displayName: cap(name), num: '', artwork: '', genus: '', flavorText: '', height: 0, weight: 0, typeNames: [], heroBg: '', stats: [], statTotal: 0, abilities: [], hasAbilities: false, evolution: [], hasEvolution: false, abilityCount: 0 }
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
// Effectiveness → static Tailwind utility class string. Every cell gets a solid
// fill so the `gap-px` over a slate gridline background reads as a continuous
// grid (the old design left 1× cells transparent → black voids you couldn't
// trace). `hover:` lifts a cell with an inset brand ring to pinpoint a matchup.
const CELL_BASE =
  'flex items-center justify-center text-xs font-bold tabular-nums aspect-square transition-colors hover:relative hover:z-10 hover:ring-2 hover:ring-inset hover:ring-brand-500'
const HEAD_BASE =
  'flex items-center justify-center text-[10px] font-bold uppercase tracking-tight text-white aspect-square'
// Fill hierarchy so the grid reads as FULL (every cell visibly distinct from
// the slate gridline showing through `gap-px`):
//   light: card white < gridline slate-200, normal slate-50, 0 slate-800
//   dark:  card slate-900 < gridline slate-700, normal slate-800, 0 slate-950
// (normal must NOT equal the card colour or cells vanish; 0 must differ from
// normal or "no effect" looks like a blank.)
const CELL_CLASS: Record<string, string> = {
  super: `${CELL_BASE} bg-emerald-500 text-white`,
  weak: `${CELL_BASE} bg-rose-400 text-white dark:bg-rose-500`,
  none: `${CELL_BASE} bg-slate-800 text-slate-100 dark:bg-slate-950 dark:text-slate-400`,
  normal: `${CELL_BASE} bg-slate-50 text-slate-300 dark:bg-slate-800 dark:text-slate-600`,
}

function buildRows(relations: Record<string, number>[]): TypeChartRowVM[] {
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

  return rows
}

export async function typeChartLoader({ req, path }: LoaderCtx): Promise<TypeChartData> {
  const relations = await Promise.all(ALL_TYPES.map((t) => fetchTypeRelations(t)))
  const rows: TypeChartRowVM[] = buildRows(relations)
  return { ...chrome(req, path, 'PokéDex · type chart', 'Type chart'), rows }
}
