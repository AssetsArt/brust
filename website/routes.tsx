// website/routes.tsx — the brust docs site. Every page is TSX; no markdown pipeline (decision 2026-10-12).
import { defineRoutes } from '@brust/core/routes'
import DocsLayout, { docsLayoutLoader } from './components/docs/DocsLayout'
import Layout, { layoutLoader } from './components/Layout'
import { DOCS_HOME, PAGES } from './lib/nav'
import HomePage, { homeLoader } from './pages/HomePage'
import NotFoundPage from './pages/NotFoundPage'
// brust build maps each route Component to its file through the DEFAULT imports of this file, so every docs page
// is imported here even though the routes come from lib/nav.ts (a page missing here fails with component-source).
import Actions from './pages/docs/Actions'
import Caching from './pages/docs/Caching'
import Cli from './pages/docs/Cli'
import Configuration from './pages/docs/Configuration'
import Deployment from './pages/docs/Deployment'
import Installation from './pages/docs/Installation'
import Introduction from './pages/docs/Introduction'
import Loaders from './pages/docs/Loaders'
import Migrating from './pages/docs/Migrating'
import ProjectStructure from './pages/docs/ProjectStructure'
import Quickstart from './pages/docs/Quickstart'
import RenderingTiers from './pages/docs/RenderingTiers'
import Routing from './pages/docs/Routing'
import Store from './pages/docs/Store'
import CloudflareAdapter from './pages/docs/cache-adapters/Cloudflare'
import CacheAdaptersOverview from './pages/docs/cache-adapters/Overview'
import RedisAdapter from './pages/docs/cache-adapters/Redis'
import WriteYourOwn from './pages/docs/cache-adapters/WriteYourOwn'
import CloudflareCache from './pages/docs/cloudflare/Cache'
import D1 from './pages/docs/cloudflare/D1'
import Workers from './pages/docs/cloudflare/Workers'
import FormAction from './pages/docs/cookbook/FormAction'
import HelloWorld from './pages/docs/cookbook/HelloWorld'
import InvalidateCache from './pages/docs/cookbook/InvalidateCache'
import ReactIsland from './pages/docs/cookbook/ReactIsland'
import Static404 from './pages/docs/cookbook/Static404'

const home = PAGES.find((p) => p.slug === DOCS_HOME)!

export const routes = defineRoutes([
  {
    Component: Layout,
    loader: layoutLoader,
    children: [
      { path: '/', Component: HomePage, loader: homeLoader },
      // Docs: /docs is the docs home; every nav entry is /docs/{slug} (lib/nav.ts) inside the docs shell.
      {
        Component: DocsLayout,
        loader: docsLayoutLoader,
        children: [
          { path: '/docs', Component: home.Component, ...(home.loader ? { loader: home.loader } : {}) },
          ...PAGES.map((p) => ({ path: `/docs/${p.slug}`, Component: p.Component, ...(p.loader ? { loader: p.loader } : {}) })),
        ],
      },
    ],
  },
  // Outside the layout: a static full document, no scripts.
  { path: '*', Component: NotFoundPage },
])
