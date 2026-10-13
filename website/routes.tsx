// website/routes.tsx — the brust docs site. Every page is TSX; no markdown pipeline (decision 2026-10-12).
import { defineRoutes } from '@brust/core/routes'
import DocsLayout, { docsLayoutLoader } from './components/docs/DocsLayout'
import Layout, { layoutLoader } from './components/Layout'
import { DOCS_HOME, PAGES } from './lib/nav'
import HomePage, { homeLoader } from './pages/HomePage'
import NotFoundPage from './pages/NotFoundPage'
import DemoPokemonPage, { demoPokemonLoader } from './components/demos/DemoPokemonPage'
// Every docs page is imported by lib/nav.ts; brust build follows the import graph from this file (F99), so no
// page needs a default import here any more.

const home = PAGES.find((p) => p.slug === DOCS_HOME)!

export const routes = defineRoutes([
  {
    Component: Layout,
    loader: layoutLoader,
    children: [
      { path: '/', Component: HomePage, loader: homeLoader },
      // Demo block (site-docs-guide): a cached route with a param, fetched by the Caching page and linked from Loaders.
      {
        path: '/demo/pokemon/{name}',
        Component: DemoPokemonPage,
        loader: demoPokemonLoader,
        cache: { ttl_seconds: 60, tags: ['pokemon'], bypass: 'query(nocache)' },
        // The page varies per request (the bypass reads the query), so the static build skips it (ssg-varies): it exists on a local run only.
        ssg: false,
      },
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
