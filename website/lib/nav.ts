// website/lib/nav.ts — the docs sidebar (canon order): groups of pages, each a slug under /docs, a title, its TSX file
// and its component (plus its loader when the page has one). routes.tsx generates /docs/{slug} from it, and
// docsLayoutLoader derives the sidebar, breadcrumbs, pager and edit link for the current page.
import type { ComponentType } from 'react'
import type { LoaderCtx } from '@brust/core/routes'
import Actions from '../pages/docs/Actions'
import Caching from '../pages/docs/Caching'
import Cli from '../pages/docs/Cli'
import Configuration from '../pages/docs/Configuration'
import Deployment from '../pages/docs/Deployment'
import Installation from '../pages/docs/Installation'
import Introduction, { introductionLoader } from '../pages/docs/Introduction'
import Loaders from '../pages/docs/Loaders'
import Migrating from '../pages/docs/Migrating'
import ProjectStructure from '../pages/docs/ProjectStructure'
import Quickstart, { quickstartLoader } from '../pages/docs/Quickstart'
import RenderingTiers from '../pages/docs/RenderingTiers'
import Routing from '../pages/docs/Routing'
import Store from '../pages/docs/Store'
import CloudflareAdapter from '../pages/docs/cache-adapters/Cloudflare'
import CacheAdaptersOverview from '../pages/docs/cache-adapters/Overview'
import RedisAdapter from '../pages/docs/cache-adapters/Redis'
import WriteYourOwn from '../pages/docs/cache-adapters/WriteYourOwn'
import CloudflareCache from '../pages/docs/cloudflare/Cache'
import D1 from '../pages/docs/cloudflare/D1'
import Workers from '../pages/docs/cloudflare/Workers'
import FormAction from '../pages/docs/cookbook/FormAction'
import HelloWorld from '../pages/docs/cookbook/HelloWorld'
import InvalidateCache from '../pages/docs/cookbook/InvalidateCache'
import ReactIsland from '../pages/docs/cookbook/ReactIsland'
import Static404 from '../pages/docs/cookbook/Static404'

export interface NavItem {
  /** Path under /docs, e.g. `quickstart` or `cookbook/hello-world`. */
  slug: string
  title: string
  /** The page's source, relative to website/ (the "Edit this page" link). */
  file: string
  Component: ComponentType<any>
  loader?: (ctx: LoaderCtx) => unknown
}

export interface NavGroup {
  group: string
  items: NavItem[]
}

export const NAV: NavGroup[] = [
  {
    group: 'Guide',
    items: [
      { slug: 'introduction', title: 'Introduction', file: 'pages/docs/Introduction.tsx', Component: Introduction, loader: introductionLoader },
      { slug: 'installation', title: 'Installation', file: 'pages/docs/Installation.tsx', Component: Installation },
      { slug: 'quickstart', title: 'Quickstart', file: 'pages/docs/Quickstart.tsx', Component: Quickstart, loader: quickstartLoader },
      { slug: 'project-structure', title: 'Project structure', file: 'pages/docs/ProjectStructure.tsx', Component: ProjectStructure },
      { slug: 'routing', title: 'Routing', file: 'pages/docs/Routing.tsx', Component: Routing },
      { slug: 'loaders', title: 'Loaders and params', file: 'pages/docs/Loaders.tsx', Component: Loaders },
      { slug: 'rendering-tiers', title: 'Rendering tiers', file: 'pages/docs/RenderingTiers.tsx', Component: RenderingTiers },
      { slug: 'caching', title: 'Caching', file: 'pages/docs/Caching.tsx', Component: Caching },
      { slug: 'actions', title: 'Actions', file: 'pages/docs/Actions.tsx', Component: Actions },
      { slug: 'store', title: 'Store', file: 'pages/docs/Store.tsx', Component: Store },
      { slug: 'configuration', title: 'Configuration', file: 'pages/docs/Configuration.tsx', Component: Configuration },
      { slug: 'cli', title: 'CLI', file: 'pages/docs/Cli.tsx', Component: Cli },
      { slug: 'deployment', title: 'Deployment', file: 'pages/docs/Deployment.tsx', Component: Deployment },
      { slug: 'migrating', title: 'Migrating from 0.1.x', file: 'pages/docs/Migrating.tsx', Component: Migrating },
    ],
  },
  {
    group: 'Cloudflare',
    items: [
      { slug: 'cloudflare/workers', title: 'Workers target', file: 'pages/docs/cloudflare/Workers.tsx', Component: Workers },
      { slug: 'cloudflare/d1', title: 'D1 recipe', file: 'pages/docs/cloudflare/D1.tsx', Component: D1 },
      { slug: 'cloudflare/cache', title: 'Cache on KV and DO', file: 'pages/docs/cloudflare/Cache.tsx', Component: CloudflareCache },
    ],
  },
  {
    group: 'Cache adapters',
    items: [
      { slug: 'cache-adapters/overview', title: 'Overview', file: 'pages/docs/cache-adapters/Overview.tsx', Component: CacheAdaptersOverview },
      { slug: 'cache-adapters/redis', title: 'Redis and Dragonfly', file: 'pages/docs/cache-adapters/Redis.tsx', Component: RedisAdapter },
      { slug: 'cache-adapters/cloudflare', title: 'Cloudflare', file: 'pages/docs/cache-adapters/Cloudflare.tsx', Component: CloudflareAdapter },
      { slug: 'cache-adapters/write-your-own', title: 'Write your own', file: 'pages/docs/cache-adapters/WriteYourOwn.tsx', Component: WriteYourOwn },
    ],
  },
  {
    group: 'Cookbook',
    items: [
      { slug: 'cookbook/hello-world', title: 'Hello world', file: 'pages/docs/cookbook/HelloWorld.tsx', Component: HelloWorld },
      { slug: 'cookbook/react-island', title: 'A React island', file: 'pages/docs/cookbook/ReactIsland.tsx', Component: ReactIsland },
      { slug: 'cookbook/form-action', title: 'Form action', file: 'pages/docs/cookbook/FormAction.tsx', Component: FormAction },
      { slug: 'cookbook/static-404', title: 'Static 404 page', file: 'pages/docs/cookbook/Static404.tsx', Component: Static404 },
      { slug: 'cookbook/invalidate-the-cache', title: 'Invalidate the cache', file: 'pages/docs/cookbook/InvalidateCache.tsx', Component: InvalidateCache },
    ],
  },
]

/** Every page in reading order (the pager walks it), with its group. */
export const PAGES: (NavItem & { group: string })[] = NAV.flatMap((g) => g.items.map((i) => ({ ...i, group: g.group })))

/** `/docs` shows this page. */
export const DOCS_HOME = 'introduction'

/** The branch the site's source lives on; edit links follow it. Flip when the site lands elsewhere. */
export const EDIT_BRANCH = 'docs-site'

export const EDIT_BASE = `https://github.com/AssetsArt/brust/blob/${EDIT_BRANCH}/website/`

export const href = (slug: string): string => `/docs/${slug}`

/** One sidebar group: its heading and its page links (`current` marks the page being read). */
export interface SideGroup {
  group: string
  items: { href: string; title: string; current: boolean }[]
}

export interface PagerLink {
  href: string
  title: string
}

export interface DocsNavData {
  title: string
  crumb: string
  side: SideGroup[]
  prev?: PagerLink
  next?: PagerLink
  editUrl: string
  toc: TocItem[]
}

export interface TocItem {
  id: string
  title: string
}

/** Sidebar, breadcrumb, pager and edit link for the page at `path` (`/docs` is the docs home); undefined off the map. */
export function docsNav(path: string): DocsNavData | undefined {
  const slug = path.replace(/^\/docs\/?/, '').replace(/\/$/, '') || DOCS_HOME
  const at = PAGES.findIndex((p) => p.slug === slug)
  const page = PAGES[at]
  if (!page) return undefined
  const side: SideGroup[] = NAV.map((g) => ({
    group: g.group,
    items: g.items.map((i) => ({ href: href(i.slug), title: i.title, current: i.slug === slug })),
  }))
  const prev = PAGES[at - 1]
  const next = PAGES[at + 1]
  return {
    title: `${page.title} · brust docs`,
    crumb: `${page.group} / ${page.title}`,
    side,
    ...(prev ? { prev: { href: href(prev.slug), title: prev.title } } : {}),
    ...(next ? { next: { href: href(next.slug), title: next.title } } : {}),
    editUrl: EDIT_BASE + page.file,
    toc: [],
  }
}
