// Domain + view-model types for the PokéDex example.
//
// IMPORTANT (native constraint): the page components are `native: true` routes
// compiled to minijinja. They can only interpolate MEMBER PATHS — no helper
// calls, no `style={{…}}` objects, no string concatenation. So every formatted
// string, CSS class, and inline-style string is precomputed here in the loader
// and handed to the template as plain fields. See ../FRAMEWORK-GAPS.md §1.

/** A single list cell — derived from the list endpoint alone (no detail fetch,
 *  see FRAMEWORK-GAPS.md §2 / N+1 avoidance). */
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
  // Native routes can't use conditionals, so "disabled" is a precomputed class
  // (pointer-events:none) rather than `{hasPrev ? <a> : <span>}`. See GAPS §11.
  prevClass: string
  nextClass: string
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
  barWidth: string // "width:62%"
  barClassName: string // "dex-statbar__fill dex-statbar__fill--mid"
}

export interface AbilityVM {
  displayName: string // "Overgrow"
  initial: string // "O"
  iconStyle: string // "background:var(--success-500)"
}

export interface EvolutionStageVM {
  id: number
  name: string
  displayName: string
  num: string
  artwork: string
  detailHref: string
  levelLabel: string // "Lv 16"
  // Conditionals aren't allowed in native routes, so the arrow/level separators
  // are always rendered and hidden via these precomputed classes. See GAPS §11.
  sepClassName: string // "dex-evo__sep" (+ " dex-hide" on the first stage)
  levelClassName: string // "dex-evo__lv" (+ " dex-hide" when there's no level)
  cardClassName: string // adds the "current" highlight when this is the open Pokémon
}

/** The full view-model handed to DetailPage. Every field is render-ready. */
export interface DetailData {
  notFound: boolean
  // Native routes can't branch with `{notFound ? … : …}`, so BOTH the content
  // and the 404 block are always emitted and one is hidden by a precomputed
  // class. See FRAMEWORK-GAPS.md §11.
  contentClass: string // "dex-detail-grid" (+ " dex-hide" when notFound)
  notFoundClass: string // "dex-notfound" (+ " dex-hide" when found)
  abilitiesClass: string // hidden when the Pokémon has no abilities
  evoSectionClass: string // hidden when there's no multi-stage evolution
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
  heroStyle: string // "background:linear-gradient(…)" — type-tinted
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
 *  aren't proven on the native path, so we avoid them. See FRAMEWORK-GAPS.md §10. */
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
