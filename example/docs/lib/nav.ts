// Single source of truth for the docs information architecture. Rendered by the
// native sidebar (Layout, as nested `.map()` → jinja `{% for %}`, zero JS) AND
// served as JSON by the `/docs` action (which auto-becomes an MCP tool). The
// active-link highlight is computed SERVER-SIDE per request via `navFor(active)`
// — each link carries a precomputed `cls` (a loader-var member-path the native
// template renders directly), so the highlight ships as static HTML with no JS.

export const REPO = 'https://github.com/AssetsArt/brust'

export interface NavLinkItem {
  label: string
  href: string
}

export interface NavSection {
  title: string
  links: NavLinkItem[]
}

/** The grouped navigation, in document order. */
export const NAV: NavSection[] = [
  {
    title: 'Getting Started',
    links: [
      { label: 'Introduction', href: '/docs/introduction' },
      { label: 'Installation', href: '/docs/installation' },
      { label: 'Project structure', href: '/docs/project-structure' },
      { label: 'Your first route', href: '/docs/first-route' },
      { label: 'Dev & build', href: '/docs/commands' },
    ],
  },
  {
    title: 'Core concepts',
    links: [
      { label: 'Routing', href: '/docs/routing' },
      { label: 'Rendering', href: '/docs/rendering' },
      { label: 'Native interactivity', href: '/docs/native-interactivity' },
      { label: 'State — the store', href: '/docs/store' },
      { label: 'Actions & API', href: '/docs/actions' },
      { label: 'Styling', href: '/docs/styling' },
    ],
  },
  {
    title: 'Platform',
    links: [
      { label: 'Agents · MCP', href: '/docs/agents' },
      { label: 'CLI', href: '/docs/cli' },
      { label: 'Deployment', href: '/docs/deployment' },
    ],
  },
]

/** Flat, document-ordered list (Home first) — drives prev/next. */
export const FLAT: NavLinkItem[] = [{ label: 'Home', href: '/' }, ...NAV.flatMap((s) => s.links)]

// ── Server-rendered shapes (carry precomputed classes; native templates can't
//    branch per map item, so the branch happens here) ──────────────────────────

export interface NavLinkView extends NavLinkItem {
  /** Full className for the <a>, including the active modifier when current. */
  cls: string
  /** Active rail span class — visible only on the current link. */
  railCls: string
}
export interface NavSectionView {
  title: string
  links: NavLinkView[]
}

/** Build the sidebar for the given active path, baking the active highlight into
 * each link's class so the template stays branch-free. */
export function navFor(active: string): NavSectionView[] {
  return NAV.map((section) => ({
    title: section.title,
    links: section.links.map((link) => {
      const on = link.href === active
      return {
        ...link,
        cls: on ? 'b-navlink b-navlink--active' : 'b-navlink',
        railCls: on ? 'b-navlink__rail' : 'b-navlink__rail b-navlink__rail--off',
      }
    }),
  }))
}

export interface PrevNext {
  prevHref: string
  prevTitle: string
  /** Card class — carries a `--hide` modifier when there is no previous page, so
   * the native template renders two cards unconditionally (no per-cell branch). */
  prevCls: string
  nextHref: string
  nextTitle: string
  nextCls: string
}

const PAGER = 'b-pager__card'
const PAGER_NEXT = 'b-pager__card b-pager__card--next'

/** Previous / next page for the footer pager, by active path. */
export function prevNextFor(active: string): PrevNext {
  const i = FLAT.findIndex((x) => x.href === active)
  const prev = i > 0 ? FLAT[i - 1] : undefined
  const next = i >= 0 && i < FLAT.length - 1 ? FLAT[i + 1] : undefined
  return {
    prevHref: prev?.href ?? '#',
    prevTitle: prev?.label ?? '',
    prevCls: prev ? PAGER : `${PAGER} b-pager__hide`,
    nextHref: next?.href ?? '#',
    nextTitle: next?.label ?? '',
    nextCls: next ? PAGER_NEXT : `${PAGER_NEXT} b-pager__hide`,
  }
}
