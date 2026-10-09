// Domain + view-model types for the PokéDex example.
//
// Loaders return plain data; components are ordinary React functions.

/** Team roster member. */
export interface TeamMember {
  id: number
  name: string
  displayName: string
  types: string[]
  artwork: string
  num: string
}

/** Chrome view-model the router-level AppLayout reads from the MERGED loader
 *  context. Each leaf loader returns these fields; the chain-loader merge folds
 *  them into the one flat jinja context AppLayout's template reads. */
export interface NavItem {
  href: string
  label: string
  active: boolean
}

export interface ChromeData {
  title: string
  crumb: string
  mode: 'dark' | 'light'
  nav: NavItem[]
  teamInitial: TeamMember[]
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

/** One base-stat bar row on the detail page. All formatting precomputed. */
export interface StatBarVM {
  label: string // "HP" / "Atk" …
  base: number // raw base value
  barWidth: string // "62%" — fed into style={{ width }}
  barColor: string // hex per bucket — fed into style={{ background }}
}

/** One ability chip on the detail page. */
export interface AbilityVM {
  displayName: string // "Overgrow"
  initial: string // "O"
  iconColor: string // hex tint — style={{ background }}
}

/** One stage of the evolution chain. */
export interface EvoStageVM {
  id: number
  displayName: string
  num: string // "#0001"
  artwork: string
  detailHref: string // "/pokemon/ivysaur"
  levelLabel: string // "Lv 16" or ""
  isFirst: boolean
  showLevel: boolean
  isCurrent: boolean
}

/** One "browse by type" tile on the home page. */
export interface TypeTileVM {
  name: string // raw type key, used as the .map() key
  label: string // "Grass"
  color: string // hex tint — fed into an inline style value
  href: string // "/pokedex"
}

/** Home landing page data — curated featured strip + type tiles + chrome. */
export interface HomeData extends ChromeData {
  featured: DexCard[]
  types: string[]
  typeTiles: TypeTileVM[]
}

/** Browse (dex grid) page data. `items` feeds BOTH the SSR `{% for %}` and the
 *  DexFilter directive's `x-props` (json_attr-serialized) — one array, no separate
 *  pre-stringified JSON. */
export interface BrowseData extends ChromeData {
  items: DexCard[]
  q: string
}

/** Detail page data. Every formatted string / className / inline-style value /
 *  x-props JSON is precomputed here so the native template only interpolates. */
export interface DetailData extends ChromeData {
  notFound: boolean
  name: string
  id: number
  displayName: string
  num: string // "#0001"
  artwork: string
  genus: string // "Seed Pokémon"
  flavorText: string
  heightLabel: string // "0.7 m"
  weightLabel: string // "6.9 kg"
  abilityCount: number
  heroBg: string // CSS gradient string built in the loader from the type tint
  types: TypeBadgeVM[]
  stats: StatBarVM[]
  statTotal: number
  abilities: AbilityVM[]
  hasAbilities: boolean
  evolution: EvoStageVM[]
  hasEvolution: boolean
  height: number
  weight: number
  typeNames: string[]
}

/** One cell of the type chart. */
export interface TypeChartCellVM {
  id: string // stable key "row-col"
  className: string // static Tailwind utility string the loader picks per effectiveness
  content: string // "2", "½", "0", a type short-code, or ""
  title: string // tooltip
  bg: string // inline background — type hex for header/row-head cells, '' for data cells
}

/** One row (header or attack) of the type chart — nested cells. */
export interface TypeChartRowVM {
  id: string
  cells: TypeChartCellVM[]
}

/** Type chart page data — nested rows[].cells[] grid, rendered with nested .map(). */
export interface TypeChartData extends ChromeData {
  rows: TypeChartRowVM[]
}
