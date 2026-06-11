import { isWorker } from 'brustjs'
import { defineRoutes, mdRoutes } from 'brustjs/routes'
import DocsLayout from './components/DocsLayout'
import { buildDocsChrome } from './lib/nav.ts'
import { generateSearchIndex } from './lib/search-index.ts'
import Home from './pages/Home'

// Search index: generated at import time, main process only (workers share
// the fs; regenerating per worker would race the write). Runs BEFORE mdRoutes
// so the json exists before anything renders. See lib/search-index.ts.
if (!isWorker) generateSearchIndex()

// Doc pages are markdown under content/, mounted at /docs via mdRoutes with
// the DocsLayout chrome. The content dir is passed as the RELATIVE string
// 'content' — the manifest-stable pattern (the frozen md-manifest records the
// same relative string, cwd = example/docs). Component registry fills in as
// md-embedded demos land (Plan 2).
//
// Sidebar/pager chrome: mdRoutes has no first-class loader option for the
// layout parent (FRAMEWORK-GAPS.md), so the loader is attached to the
// returned tree node. Chain loaders merge top-down — the leaf's `__md` head
// fields win because buildDocsChrome returns ONLY { nav, pager }.
const [docsTree] = mdRoutes('content', { prefix: '/docs', layout: DocsLayout, components: {} })
docsTree.loader = async ({ path }) => buildDocsChrome(path)

// Home is a native landing page (real hero lands in task 1.5).
export const routes = defineRoutes([{ path: '/', Component: Home, native: true }, docsTree])
