// Domain + view-model types for the PokéDex example.
//
// NATIVE NOTE: the page components are `native: true` routes compiled to
// minijinja. Loaders precompute formatted strings, classNames, hrefs, inline
// style values, and x-props JSON; the templates only interpolate member-paths,
// run `.map()`, and branch on inline conditionals.

/** In-process / island team store member. */
export interface TeamMember {
  id: number
  name: string
  displayName: string
  types: string[]
  artwork: string
  num: string
  addedAt: number
}

/** Chrome view-model the router-level AppLayout reads from the MERGED loader
 *  context. Each leaf loader returns these fields; the chain-loader merge folds
 *  them into the one flat jinja context AppLayout's template reads. */
export interface ChromeData {
  title: string // dynamic <title> + nav header, via AppLayout's <BrustPage title={title}>
  crumb: string // topbar breadcrumb leaf label
  mode: 'dark' | 'light' // theme, read from the `mode` cookie → <html data-mode={mode}>
  teamProps: { teamInitial: TeamMember[] } // floating team-dock island initial state
}

/** A single dex grid cell — derived from the list endpoint alone (no detail
 *  fetch). */
export interface DexCard {
  id: number
  name: string
  displayName: string // "Bulbasaur"
  num: string // "#0001"
  artwork: string // CDN URL derived from id
  detailHref: string // "/pokemon/bulbasaur"
}

export interface TypeBadgeVM {
  label: string // "Grass"
  color: string // hex tint — fed into an inline style value
}

/** Home landing page data. Minimal for slice 1. */
export interface HomeData extends ChromeData {
  heading: string
}

/** Browse (dex grid) page data. `dexProps` is the loader-precomputed JSON
 *  string handed to the browse island; real grid data lands in a later slice. */
export interface BrowseData extends ChromeData {
  heading: string
  dexProps: string
}

/** Detail page data. Fields beyond chrome land in a later slice. */
export interface DetailData extends ChromeData {
  notFound: boolean
  name: string
  displayName: string
  addProps: string // loader-precomputed x-props JSON for AddToTeamButton
}

/** One cell of the type chart. */
export interface TypeChartCellVM {
  id: string // stable key "row-col"
  className: string // static utility string
  content: string // "2", "½", "0", a type short-code, or ""
  title: string // tooltip
}

/** Type chart page data. */
export interface TypeChartData extends ChromeData {
  heading: string
}
