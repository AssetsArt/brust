// Route loaders. Each runs in a Bun worker (full JS), fetches from PokeAPI, and
// returns a fully render-ready view-model. Templates now do conditionals (S11),
// `style={{…}}` objects (S1), and dynamic head props (S8); the loader still
// precomputes formatted strings, booleans for conditionals, and multi-property
// style strings (no template-literals / arithmetic / helper calls in templates).
// See ../FRAMEWORK-GAPS.md.

import { z } from 'zod'
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
import type { DetailData, ListData, TypeBadgeVM, TypeChartCellVM, TypeChartData } from './types'

/** Loader context shape — `loader: ({ params, path, req }) => data`. */
interface LoaderCtx {
  params: Record<string, string>
  path: string
  req: BrustRequest
}

const PAGE = 20
const NATIONAL_MAX = 1302

// GAP S1: query validation is not symmetric with actions. Actions bind a schema
// in the descriptor and hand the handler a typed+validated `query`; loaders get
// `req.search` as a raw Record<string,string> and must validate by hand here.
const ListQuery = z.object({
  offset: z.coerce.number().int().min(0).max(NATIONAL_MAX).catch(0),
})

const fmt = (n: number) => n.toLocaleString('en-US')
const typeBadge = (t: string): TypeBadgeVM => ({
  label: cap(t),
  className: `dex-type dex-type--${t}`,
})

export async function listLoader({ req }: LoaderCtx): Promise<ListData> {
  const offset = ListQuery.parse(req?.search ?? {}).offset
  const { results, total } = await fetchList(offset, PAGE)

  const items = results.map((r) => ({
    id: r.id,
    name: r.name,
    displayName: cap(r.name),
    num: pad(r.id),
    artwork: artwork(r.id),
    detailHref: `/pokemon/${r.name}`,
  }))

  const lastPage = Math.ceil(total / PAGE)
  const pageNo = Math.floor(offset / PAGE) + 1
  const hasPrev = offset > 0
  const hasNext = offset + PAGE < total
  const prevOffset = Math.max(0, offset - PAGE)

  return {
    items,
    total,
    totalLabel: fmt(total),
    offset,
    offsetLabel: String(offset),
    showingLabel: `${fmt(offset + 1)}–${fmt(Math.min(offset + PAGE, total))} of ${fmt(total)}`,
    pageLabel: `${pageNo} / ${lastPage}`,
    // Real conditionals now exist in native routes (GAPS S11 closed): the
    // template branches on these booleans with `{flags.hasPrev ? <a/> : <span/>}`
    // instead of always-rendering a loader-computed hide-class.
    hasPrev,
    hasNext,
    prevHref: hasPrev ? (prevOffset > 0 ? `/?offset=${prevOffset}` : '/') : '#',
    nextHref: hasNext ? `/?offset=${offset + PAGE}` : '#',
    teamProps: { teamInitial: teamStore.list() },
  }
}

export async function detailLoader({ params }: LoaderCtx): Promise<DetailData | NativeVerdict> {
  const name = params?.name ?? ''
  const empty = emptyDetail(name)

  const p = await fetchPokemon(name)
  // GAP S9 (FIXED): native loaders can now `return notFound(data)` to render the
  // route's OWN template with HTTP 404. The `notFound: true` flag on `empty`
  // still drives the template's 404-block branch (S11); the sentinel sets the
  // HTTP STATUS (404 instead of 200). They are complementary. See GAPS S9.
  if (!p) return notFound(empty)

  const species = await fetchSpecies(p.id)
  // GAP (native↔streaming): a native route renders in Rust with NO React tree,
  // so <Suspense> streaming is impossible. The evolution chain — the slow fetch
  // the design wanted to stream — is therefore loaded BLOCKING here in the
  // loader. See GAPS S3.
  const rawEvo = await fetchEvolution(species.evolutionUrl)

  const primary = p.types[0] ?? 'normal'
  const tint = TYPE_COLOR[primary] ?? 'var(--primary-500)'

  const stats = p.stats.map((s) => {
    const pct = Math.min(100, Math.round((s.base / 200) * 100))
    return {
      label: STAT_LABEL[s.name] ?? s.name,
      base: s.base,
      // Bare percent — the template builds the declaration via the S1 style
      // object: `style={{ width: st.barWidth }}` → `width:62%`.
      barWidth: `${pct}%`,
      barClassName: `dex-statbar__fill dex-statbar__fill--${statBucket(s.base)}`,
    }
  })

  const abilities = p.abilities.map((a) => ({
    displayName: cap(a),
    initial: a.charAt(0).toUpperCase(),
    // Bare color value — template does `style={{ background: a.iconColor }}`.
    iconColor: tint,
  }))

  const evolution = rawEvo.map((s, i) => ({
    id: s.id,
    name: s.name,
    displayName: cap(s.name),
    num: pad(s.id),
    artwork: artwork(s.id),
    detailHref: `/pokemon/${s.name}`,
    levelLabel: s.minLevel != null ? `Lv ${s.minLevel}` : '',
    // Real per-item conditionals now work in native routes (S11): the template
    // tests these booleans instead of toggling a precomputed `dex-hide` class.
    isFirst: i === 0,
    showLevel: i > 0 && s.minLevel != null,
    cardClassName: s.id === p.id ? 'dex-evo__card dex-evo__card--current' : 'dex-evo__card',
  }))

  const hasEvolution = evolution.length > 1

  return {
    notFound: false,
    pageTitle: `${cap(p.name)} · PokéDex`,
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
    heroBg: `linear-gradient(160deg, color-mix(in srgb, ${tint} 22%, var(--surface-raised)), var(--surface-raised) 70%)`,
    types: p.types.map(typeBadge),
    stats,
    statTotal: p.stats.reduce((a, s) => a + s.base, 0),
    abilities,
    hasAbilities: abilities.length > 0,
    evolution,
    hasEvolution,
    // Native templates can't call JSON.stringify, so precompute the x-props JSON
    // here. The compiler emits it as x-props="{{ (addProps) | e }}" (XSS-safe);
    // the directive runtime JSON.parses it back into the behavior's `props`.
    addProps: JSON.stringify({
      id: p.id,
      name: p.name,
      displayName: cap(p.name),
      num: pad(p.id),
      types: p.types,
      artwork: p.artwork,
    }),
    teamProps: { teamInitial: teamStore.list() },
  }
}

function emptyDetail(name: string): DetailData {
  return {
    notFound: true,
    pageTitle: `${cap(name)} · PokéDex`,
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
    teamProps: { teamInitial: teamStore.list() },
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

export async function typeChartLoader(): Promise<TypeChartData> {
  // GAP S2: no loader-level batch/parallel helper or request-scoped cache — we
  // fan out 18 fetches by hand with Promise.all (and there is no dedupe).
  const relations = await Promise.all(ALL_TYPES.map((t) => fetchTypeRelations(t)))

  // Build the 19×19 grid as nested rows (header row + one row per attacking
  // type). The native template renders it with nested `.map()` — rows.map(r =>
  // r.cells.map(c => …)) — into the CSS grid (`.dex-tc__row{display:contents}`
  // keeps every cell a direct grid item, so the layout is unchanged).
  const rows: TypeChartData['rows'] = []

  // Header row: corner + 18 defending-type column heads.
  const headerCells: TypeChartCellVM[] = [
    {
      id: '0-0',
      className: 'dex-tc__corner',
      content: 'ATK ＼ DEF',
      title: 'Attacking ＼ Defending',
    },
  ]
  ALL_TYPES.forEach((def, j) => {
    headerCells.push({
      id: `0-${j + 1}`,
      className: `dex-tc__colhead dex-tc__colhead--${def}`,
      content: SHORT[def] ?? def.slice(0, 3).toUpperCase(),
      title: cap(def),
    })
  })
  rows.push({ id: '0', cells: headerCells })

  // One row per attacking type: row head + 18 effectiveness cells.
  ALL_TYPES.forEach((atk, i) => {
    const rel = relations[i]!
    const rowCells: TypeChartCellVM[] = [
      {
        id: `${i + 1}-0`,
        className: `dex-tc__rowhead dex-tc__rowhead--${atk}`,
        content: SHORT[atk] ?? atk.slice(0, 3).toUpperCase(),
        title: cap(atk),
      },
    ]
    ALL_TYPES.forEach((def, j) => {
      const mult = rel[def]
      const id = `${i + 1}-${j + 1}`
      if (mult === 2)
        rowCells.push({
          id,
          className: 'dex-tc__cell dex-tc__cell--super',
          content: '2',
          title: `${cap(atk)} → ${cap(def)}: 2× (super effective)`,
        })
      else if (mult === 0.5)
        rowCells.push({
          id,
          className: 'dex-tc__cell dex-tc__cell--weak',
          content: '½',
          title: `${cap(atk)} → ${cap(def)}: ½× (not very effective)`,
        })
      else if (mult === 0)
        rowCells.push({
          id,
          className: 'dex-tc__cell dex-tc__cell--none',
          content: '0',
          title: `${cap(atk)} → ${cap(def)}: 0× (no effect)`,
        })
      else
        rowCells.push({
          id,
          className: 'dex-tc__cell',
          content: '',
          title: `${cap(atk)} → ${cap(def)}: 1×`,
        })
    })
    rows.push({ id: String(i + 1), cells: rowCells })
  })

  return {
    rows,
    teamProps: { teamInitial: teamStore.list() },
  }
}
