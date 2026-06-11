import { isWorker } from 'brustjs'
import { defineRoutes, mdRoutes } from 'brustjs/routes'
import { generateSearchIndex } from './lib/search-index.ts'
import Home from './pages/Home'

// Search index: generated at import time, main process only (workers share
// the fs; regenerating per worker would race the write). Runs BEFORE mdRoutes
// so the json exists before anything renders. See lib/search-index.ts.
if (!isWorker) generateSearchIndex()

// Home is a native landing page (real hero lands in task 1.5). Doc pages are
// markdown under content/, mounted at /docs via mdRoutes. The content dir is
// passed as the RELATIVE string 'content' — the manifest-stable pattern (the
// frozen md-manifest records the same relative string, cwd = example/docs).
// Layout + loader chrome attach in task 1.3; component registry fills in as
// md-embedded demos land.
export const routes = defineRoutes([
  { path: '/', Component: Home, native: true },
  ...mdRoutes('content', { prefix: '/docs', components: {} }),
])
