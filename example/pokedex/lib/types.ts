// Domain + view-model types for the PokéDex example.
//
// NATIVE NOTE: the page components are `native: true` routes compiled to
// minijinja. They now support conditionals (S11), `style={{…}}` object attrs
// (S1), and dynamic `<BrustPage>` head props (S8) — all ✅ FIXED. Still
// precomputed in the loader: formatted strings, helper-derived values, and
// multi-property style strings (templates have no template-literals / arithmetic
// / helper calls). See ../FRAMEWORK-GAPS.md.

/** Chrome view-model the router-level AppLayout reads from the MERGED loader
 *  context (Approach a — native <Outlet/> nesting). AppLayout takes NO props at
 *  its call site (`<AppLayout native>`), so each leaf loader returns these
 *  fields and the chain-loader merge folds them into the one flat jinja context
 *  AppLayout's template reads ({{ title }}, active === 'list', teamProps). The
 *  key names are chosen NOT to collide with any page-data field. */
export interface ChromeData {
  title: string // dynamic <title> + nav header, via AppLayout's <BrustPage title={title}>
  active: 'list' | 'typechart' // which sidebar nav item gets is-active (S11 conditional)
  crumb: string // topbar breadcrumb leaf label
  teamProps: { teamInitial: TeamMember[] } // floating team-dock island initial state
  mode: 'dark' | 'light' // theme, read from the `mode` cookie → <html data-mode={mode}>
}

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

export interface ListData extends ChromeData {
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
export interface DetailData extends ChromeData {
  notFound: boolean
  // Native routes now branch with `{notFound ? <NotFound/> : <Content/>}` (S11),
  // so the content and 404 block are mutually exclusive at render time rather
  // than both emitted with one hidden via a precomputed class.
  // The dynamic <title> is `title` (ChromeData), read by AppLayout's
  // <BrustPage title={title}> — no separate pageTitle field.
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
  // native interactive props: a single string path each (native props can't be
  // object literals). addProps is the loader-precomputed JSON string handed to
  // <AddToTeamButton data={addProps} /> → x-props (Spec B native directives).
  addProps: string
}

/** Shape of the AddToTeamButton native behavior's `props` (JSON-parsed from
 *  x-props). Matches the action body fields so toggle() can post it directly. */
export interface AddToTeamProps {
  id: number
  name: string
  displayName: string
  num: string
  types: string[]
  artwork: string
}

/** One cell of the type chart. */
export interface TypeChartCellVM {
  id: string // stable key "row-col"
  className: string // "dex-tc__cell dex-tc__cell--super"
  content: string // "2", "½", "0", a type short-code, or ""
  title: string // tooltip
}

/** One row of the type chart (header row + one row per attacking type). The
 *  native template renders rows.map(r => r.cells.map(c => …)) — nested `.map()`
 *  is supported on the native path. */
export interface TypeChartRowVM {
  id: string // row index as string
  cells: TypeChartCellVM[] // 19 cells (1 head + 18)
}

export interface TypeChartData extends ChromeData {
  rows: TypeChartRowVM[] // 19 rows (1 header + 18), each 19 cells
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
