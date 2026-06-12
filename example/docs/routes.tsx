import { isWorker } from 'brustjs'
import { defineRoutes, mdRoutes } from 'brustjs/routes'
import DemoBadge from './components/DemoBadge'
import DemoCounter from './components/DemoCounter'
import DocsLayout from './components/DocsLayout'
import { buildDocsChrome } from './lib/nav.ts'
import { generateSearchIndex } from './lib/search-index.ts'
import { generateSiteFiles } from './lib/site-files.ts'
import { BRUST_VERSION } from './lib/version.ts'
import NotFound from './components/NotFound'
import Home from './pages/Home'

// Search index + discovery files (sitemap.xml, llms.txt): generated at import
// time, main process only (workers share the fs; regenerating per worker would
// race the write). Run BEFORE mdRoutes so the files exist before anything
// renders. See lib/search-index.ts and lib/site-files.ts.
if (!isWorker) {
  generateSearchIndex()
  generateSiteFiles()
}

// Doc pages are markdown under content/, mounted at /docs via mdRoutes with
// the DocsLayout chrome. The content dir is passed as the RELATIVE string
// 'content' — the manifest-stable pattern (the frozen md-manifest records the
// same relative string, cwd = example/docs). The components registry holds the
// live demos embedded in content/markdown-pages.md — three-identity rule: the
// md tag name, the registry key, and the default-import ident above must all
// match.
//
// Sidebar/pager chrome: the layout loader is a first-class mdRoutes option.
// Chain loaders merge top-down — the leaf's `__md` head fields win because
// buildDocsChrome returns ONLY { nav, pager }.
const [docsTree] = mdRoutes('content', {
  prefix: '/docs',
  layout: DocsLayout,
  components: { DemoBadge, DemoCounter },
  loader: async ({ path }) => buildDocsChrome(path),
})

// Home is a native landing page. Its loader feeds the brustjs version (read
// from the package manifest in lib/version.ts) so the release card shows the
// shipped version — the SSG export freezes it at build, never a stale literal.
// `{ path: '*' }` is the GLOBAL catch-all: the live server renders it at HTTP
// 404 for any unmatched path (native + SPA), and the SSG export crawls it to
// write `dist/static/404.html` (Cloudflare Pages serves that with HTTP 404).
// This dogfoods the framework 404 feature and retires the old hand-written
// `public/404.html` — the framework now owns the 404 page.
export const routes = defineRoutes([
  { path: '/', Component: Home, native: true, loader: async () => ({ version: BRUST_VERSION }) },
  docsTree,
  { path: '*', Component: NotFound, native: true },
])
