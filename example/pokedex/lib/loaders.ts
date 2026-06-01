// Route loaders. Each runs in a Bun worker (full JS), fetches from PokeAPI, and
// returns a fully render-ready view-model. All formatting, CSS classes, and
// inline-style strings are computed HERE because the native (jinja) page
// templates can only interpolate member paths. See ../FRAMEWORK-GAPS.md.

import { z } from 'zod'
import type { BrustRequest } from '../../../runtime/routes.ts'
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
import type { DetailData, ListData, TypeBadgeVM, TypeChartData } from './types'

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
  const btn = 'aa-btn aa-btn--secondary aa-btn--sm'

  return {
    items,
    total,
    totalLabel: fmt(total),
    offset,
    offsetLabel: String(offset),
    showingLabel: `${fmt(offset + 1)}–${fmt(Math.min(offset + PAGE, total))} of ${fmt(total)}`,
    pageLabel: `${pageNo} / ${lastPage}`,
    prevClass: hasPrev ? btn : `${btn} dex-pager__btn--off`,
    nextClass: hasNext ? btn : `${btn} dex-pager__btn--off`,
    prevHref: hasPrev ? (prevOffset > 0 ? `/?offset=${prevOffset}` : '/') : '#',
    nextHref: hasNext ? `/?offset=${offset + PAGE}` : '#',
    teamInitial: teamStore.list(),
  }
}

export async function detailLoader({ params }: LoaderCtx): Promise<DetailData> {
  const name = params?.name ?? ''
  const empty = emptyDetail(name)

  const p = await fetchPokemon(name)
  // GAP S9: no first-class notFound()/redirect() loader sentinel — a 404 from
  // PokeAPI is surfaced as a flag the template branches on, and the response is
  // still HTTP 200 (we can't set status from a native loader). See GAPS S9.
  if (!p) return empty

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
      barWidth: `width:${pct}%`,
      barClassName: `dex-statbar__fill dex-statbar__fill--${statBucket(s.base)}`,
    }
  })

  const abilities = p.abilities.map((a) => ({
    displayName: cap(a),
    initial: a.charAt(0).toUpperCase(),
    iconStyle: `background:${tint}`,
  }))

  const evolution = rawEvo.map((s, i) => {
    const showArrow = i > 0
    const showLevel = i > 0 && s.minLevel != null
    return {
      id: s.id,
      name: s.name,
      displayName: cap(s.name),
      num: pad(s.id),
      artwork: artwork(s.id),
      detailHref: `/pokemon/${s.name}`,
      levelLabel: s.minLevel != null ? `Lv ${s.minLevel}` : '',
      sepClassName: showArrow ? 'dex-evo__sep' : 'dex-evo__sep dex-hide',
      levelClassName: showLevel ? 'dex-evo__lv' : 'dex-evo__lv dex-hide',
      cardClassName: s.id === p.id ? 'dex-evo__card dex-evo__card--current' : 'dex-evo__card',
    }
  })

  const hasEvolution = evolution.length > 1

  return {
    notFound: false,
    contentClass: 'dex-detail-grid',
    notFoundClass: 'dex-notfound dex-hide',
    abilitiesClass: abilities.length > 0 ? 'dex-abilities' : 'dex-abilities dex-hide',
    evoSectionClass: hasEvolution ? 'aa-section dex-evo' : 'aa-section dex-evo dex-hide',
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
    heroStyle: `background:linear-gradient(160deg, color-mix(in srgb, ${tint} 22%, var(--surface-raised)), var(--surface-raised) 70%)`,
    types: p.types.map(typeBadge),
    stats,
    statTotal: p.stats.reduce((a, s) => a + s.base, 0),
    abilities,
    hasAbilities: abilities.length > 0,
    evolution,
    hasEvolution,
    addProps: {
      id: p.id,
      name: p.name,
      displayName: cap(p.name),
      num: pad(p.id),
      types: p.types,
      artwork: p.artwork,
    },
    teamInitial: teamStore.list(),
  }
}

function emptyDetail(name: string): DetailData {
  return {
    notFound: true,
    contentClass: 'dex-detail-grid dex-hide',
    notFoundClass: 'dex-notfound',
    abilitiesClass: 'dex-abilities dex-hide',
    evoSectionClass: 'aa-section dex-evo dex-hide',
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
    heroStyle: '',
    types: [],
    stats: [],
    statTotal: 0,
    abilities: [],
    hasAbilities: false,
    evolution: [],
    hasEvolution: false,
    addProps: { id: 0, name, displayName: cap(name), num: '', types: [], artwork: '' },
    teamInitial: teamStore.list(),
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

  // Flatten the 19×19 grid (1 header row/col + 18×18 matrix) into a single
  // row-major array so the native template renders it with ONE `.map()`.
  const cells: Array<Omit<TypeChartData['cells'][number], 'id'>> = []

  // Header row: corner + 18 defending-type column heads.
  cells.push({
    className: 'dex-tc__corner',
    content: 'ATK ＼ DEF',
    title: 'Attacking ＼ Defending',
  })
  for (const def of ALL_TYPES) {
    cells.push({
      className: `dex-tc__colhead dex-tc__colhead--${def}`,
      content: SHORT[def] ?? def.slice(0, 3).toUpperCase(),
      title: cap(def),
    })
  }

  // One row per attacking type: row head + 18 effectiveness cells.
  ALL_TYPES.forEach((atk, i) => {
    const rel = relations[i]!
    cells.push({
      className: `dex-tc__rowhead dex-tc__rowhead--${atk}`,
      content: SHORT[atk] ?? atk.slice(0, 3).toUpperCase(),
      title: cap(atk),
    })
    for (const def of ALL_TYPES) {
      const mult = rel[def]
      if (mult === 2)
        cells.push({
          className: 'dex-tc__cell dex-tc__cell--super',
          content: '2',
          title: `${cap(atk)} → ${cap(def)}: 2× (super effective)`,
        })
      else if (mult === 0.5)
        cells.push({
          className: 'dex-tc__cell dex-tc__cell--weak',
          content: '½',
          title: `${cap(atk)} → ${cap(def)}: ½× (not very effective)`,
        })
      else if (mult === 0)
        cells.push({
          className: 'dex-tc__cell dex-tc__cell--none',
          content: '0',
          title: `${cap(atk)} → ${cap(def)}: 0× (no effect)`,
        })
      else
        cells.push({
          className: 'dex-tc__cell',
          content: '',
          title: `${cap(atk)} → ${cap(def)}: 1×`,
        })
    }
  })

  return {
    cells: cells.map((c, i) => ({ id: String(i), ...c })),
    teamInitial: teamStore.list(),
  }
}
