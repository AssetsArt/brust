// website/lib/nav.ts — the docs sidebar (canon order): groups of pages, each a slug under /docs, a title, its TSX file
// and its component (plus its loader when the page has one). routes.tsx generates /docs/{slug} from it, and
// docsLayoutLoader derives the sidebar, breadcrumbs, pager and edit link for the current page.
import type { ComponentType } from 'react'
import type { LoaderCtx } from '@brust/core/routes'
import Actions, { actionsLoader } from '../pages/docs/Actions'
import Caching, { cachingLoader } from '../pages/docs/Caching'
import Cli, { cliLoader } from '../pages/docs/Cli'
import Configuration, { configurationLoader } from '../pages/docs/Configuration'
import Css, { cssLoader } from '../pages/docs/Css'
import Deployment, { deploymentLoader } from '../pages/docs/Deployment'
import Installation, { installationLoader } from '../pages/docs/Installation'
import Introduction, { introductionLoader } from '../pages/docs/Introduction'
import Loaders, { loadersLoader } from '../pages/docs/Loaders'
import Migrating, { migratingLoader } from '../pages/docs/Migrating'
import ProjectStructure, { projectStructureLoader } from '../pages/docs/ProjectStructure'
import Quickstart, { quickstartLoader } from '../pages/docs/Quickstart'
import RenderingTiers, { renderingTiersLoader } from '../pages/docs/RenderingTiers'
import Routing, { routingLoader } from '../pages/docs/Routing'
import Store, { storeLoader } from '../pages/docs/Store'
import CloudflareAdapter, { cloudflareAdapterLoader } from '../pages/docs/cache-adapters/Cloudflare'
import CacheAdaptersOverview, { overviewLoader } from '../pages/docs/cache-adapters/Overview'
import RedisAdapter, { redisLoader } from '../pages/docs/cache-adapters/Redis'
import WriteYourOwn, { writeYourOwnLoader } from '../pages/docs/cache-adapters/WriteYourOwn'
import CloudflareCache, { cloudflareCacheLoader } from '../pages/docs/cloudflare/Cache'
import D1, { d1Loader } from '../pages/docs/cloudflare/D1'
import Workers, { workersLoader } from '../pages/docs/cloudflare/Workers'
import FormAction, { formActionLoader } from '../pages/docs/cookbook/FormAction'
import HelloWorld, { helloWorldLoader } from '../pages/docs/cookbook/HelloWorld'
import InvalidateCache, { invalidateCacheLoader } from '../pages/docs/cookbook/InvalidateCache'
import ReactIsland, { reactIslandLoader } from '../pages/docs/cookbook/ReactIsland'
import Static404, { static404Loader } from '../pages/docs/cookbook/Static404'

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
      { slug: 'installation', title: 'Installation', file: 'pages/docs/Installation.tsx', Component: Installation, loader: installationLoader },
      { slug: 'quickstart', title: 'Quickstart', file: 'pages/docs/Quickstart.tsx', Component: Quickstart, loader: quickstartLoader },
      { slug: 'project-structure', title: 'Project structure', file: 'pages/docs/ProjectStructure.tsx', Component: ProjectStructure, loader: projectStructureLoader },
      { slug: 'routing', title: 'Routing', file: 'pages/docs/Routing.tsx', Component: Routing, loader: routingLoader },
      { slug: 'loaders', title: 'Loaders and params', file: 'pages/docs/Loaders.tsx', Component: Loaders, loader: loadersLoader },
      { slug: 'rendering-tiers', title: 'Rendering tiers', file: 'pages/docs/RenderingTiers.tsx', Component: RenderingTiers, loader: renderingTiersLoader },
      { slug: 'caching', title: 'Caching', file: 'pages/docs/Caching.tsx', Component: Caching, loader: cachingLoader },
      { slug: 'actions', title: 'Actions', file: 'pages/docs/Actions.tsx', Component: Actions, loader: actionsLoader },
      { slug: 'store', title: 'Store', file: 'pages/docs/Store.tsx', Component: Store, loader: storeLoader },
      { slug: 'css', title: 'CSS', file: 'pages/docs/Css.tsx', Component: Css, loader: cssLoader },
      { slug: 'configuration', title: 'Configuration', file: 'pages/docs/Configuration.tsx', Component: Configuration, loader: configurationLoader },
      { slug: 'cli', title: 'CLI', file: 'pages/docs/Cli.tsx', Component: Cli, loader: cliLoader },
      { slug: 'deployment', title: 'Deployment', file: 'pages/docs/Deployment.tsx', Component: Deployment, loader: deploymentLoader },
      { slug: 'migrating', title: 'Migrating from 0.1.x', file: 'pages/docs/Migrating.tsx', Component: Migrating, loader: migratingLoader },
    ],
  },
  {
    group: 'Cloudflare',
    items: [
      { slug: 'cloudflare/workers', title: 'Workers target', file: 'pages/docs/cloudflare/Workers.tsx', Component: Workers, loader: workersLoader },
      { slug: 'cloudflare/d1', title: 'D1 recipe', file: 'pages/docs/cloudflare/D1.tsx', Component: D1, loader: d1Loader },
      { slug: 'cloudflare/cache', title: 'Cache on KV and DO', file: 'pages/docs/cloudflare/Cache.tsx', Component: CloudflareCache, loader: cloudflareCacheLoader },
    ],
  },
  {
    group: 'Cache adapters',
    items: [
      { slug: 'cache-adapters/overview', title: 'Overview', file: 'pages/docs/cache-adapters/Overview.tsx', Component: CacheAdaptersOverview, loader: overviewLoader },
      { slug: 'cache-adapters/redis', title: 'Redis and Dragonfly', file: 'pages/docs/cache-adapters/Redis.tsx', Component: RedisAdapter, loader: redisLoader },
      { slug: 'cache-adapters/cloudflare', title: 'Cloudflare', file: 'pages/docs/cache-adapters/Cloudflare.tsx', Component: CloudflareAdapter, loader: cloudflareAdapterLoader },
      { slug: 'cache-adapters/write-your-own', title: 'Write your own', file: 'pages/docs/cache-adapters/WriteYourOwn.tsx', Component: WriteYourOwn, loader: writeYourOwnLoader },
    ],
  },
  {
    group: 'Cookbook',
    items: [
      { slug: 'cookbook/hello-world', title: 'Hello world', file: 'pages/docs/cookbook/HelloWorld.tsx', Component: HelloWorld, loader: helloWorldLoader },
      { slug: 'cookbook/react-island', title: 'A React island', file: 'pages/docs/cookbook/ReactIsland.tsx', Component: ReactIsland, loader: reactIslandLoader },
      { slug: 'cookbook/form-action', title: 'Form action', file: 'pages/docs/cookbook/FormAction.tsx', Component: FormAction, loader: formActionLoader },
      { slug: 'cookbook/static-404', title: 'Static 404 page', file: 'pages/docs/cookbook/Static404.tsx', Component: Static404, loader: static404Loader },
      { slug: 'cookbook/invalidate-the-cache', title: 'Invalidate the cache', file: 'pages/docs/cookbook/InvalidateCache.tsx', Component: InvalidateCache, loader: invalidateCacheLoader },
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
