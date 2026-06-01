// Domain + view-model types for the PokéDex example.
//
// NATIVE NOTE: the page components are `native: true` routes compiled to
// minijinja. They now support conditionals (S11), `style={{…}}` object attrs
// (S1), and dynamic `<BrustPage>` head props (S8) — all ✅ FIXED. Still
// precomputed in the loader: formatted strings, helper-derived values, and
// multi-property style strings (templates have no template-literals / arithmetic
// / helper calls). See ../FRAMEWORK-GAPS.md.

/** A single list cell — derived from the list endpoint alone (no detail fetch,
 *  see FRAMEWORK-GAPS.md S2 / N+1 avoidance). */
export interface CardVM {
  id: number
  name: string
  displayName: string // "Bulbasaur"
  num: string // "#0001"
  artwork: string // CDN URL derived from id
  detailHref: string // "/pokemon/bulbasaur"
}

export interface ListData {
  items: CardVM[]
  total: number
  totalLabel: string // "1,302"
  offset: number
  showingLabel: string // "1–20 of 1,302"
  pageLabel: string // "1 / 66"
  // Native routes now support conditionals (GAPS S11 closed): the template
  // branches with `{flags.hasPrev ? <a/> : <span/>}` on these booleans.
  hasPrev: boolean
  hasNext: boolean
  prevHref: string
  nextHref: string
  offsetLabel: string // raw offset for the loader-echo line
  teamInitial: TeamMember[]
}

export interface TypeBadgeVM {
  label: string // "Grass"
  className: string // "dex-type dex-type--grass"
}

export interface StatVM {
  label: string // "HP" / "Atk" / …
  base: number
  barWidth: string // "62%" — fed into `style={{ width: barWidth }}` (S1)
  barClassName: string // "dex-statbar__fill dex-statbar__fill--mid"
}

export interface AbilityVM {
  displayName: string // "Overgrow"
  initial: string // "O"
  iconColor: string // type tint — fed into `style={{ background: iconColor }}` (S1)
}

export interface EvolutionStageVM {
  id: number
  name: string
  displayName: string
  num: string
  artwork: string
  detailHref: string
  levelLabel: string // "Lv 16"
  // Native routes now support per-item conditionals (GAPS S11 closed): the
  // template tests these booleans (`{!s.isFirst && <Arrow/>}`) instead of
  // toggling a precomputed `dex-hide` class.
  isFirst: boolean // true on the first stage (no leading arrow)
  showLevel: boolean // true when this stage has a min level to show
  cardClassName: string // adds the "current" highlight when this is the open Pokémon
}

/** The full view-model handed to DetailPage. Every field is render-ready. */
export interface DetailData {
  notFound: boolean
  // Native routes now branch with `{notFound ? <NotFound/> : <Content/>}` (S11),
  // so the content and 404 block are mutually exclusive at render time rather
  // than both emitted with one hidden via a precomputed class.
  pageTitle: string // dynamic <title> via `<BrustPage title={d.pageTitle}>` (S8)
  name: string
  // present only when notFound === false:
  id: number
  displayName: string
  num: string
  artwork: string
  genus: string
  flavorText: string
  heightLabel: string // "0.7 m"
  weightLabel: string // "6.9 kg"
  abilityCount: number
  heroBg: string // gradient value for `style={{ background: heroBg }}` — type-tinted
  types: TypeBadgeVM[]
  stats: StatVM[]
  statTotal: number
  abilities: AbilityVM[]
  hasAbilities: boolean
  evolution: EvolutionStageVM[]
  hasEvolution: boolean
  // island props (a single path each — native island props can't be object literals):
  addProps: AddToTeamProps
  teamInitial: TeamMember[]
}

/** Props for the AddToTeamButton island (raw types kept for the action body). */
export interface AddToTeamProps {
  id: number
  name: string
  displayName: string
  num: string
  types: string[]
  artwork: string
}

/** One cell of the type chart, FLATTENED into a single row-major array so the
 *  native template renders it with ONE `.map()` into a CSS grid — nested maps
 *  aren't proven on the native path, so we avoid them. See FRAMEWORK-GAPS.md S10. */
export interface TypeChartCellVM {
  id: string // stable key (row/col coordinate)
  className: string // "dex-tc__cell dex-tc__cell--super"
  content: string // "2", "½", "0", a type short-code, or ""
  title: string // tooltip
}

export interface TypeChartData {
  cells: TypeChartCellVM[] // (18+1) × (18+1) row-major, including headers
  teamInitial: TeamMember[]
}

/** In-process team store member. */
export interface TeamMember {
  id: number
  name: string
  displayName: string
  types: string[]
  artwork: string
  num: string
  addedAt: number
}
