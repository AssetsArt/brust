// website/routes.tsx — the brust docs site. Every page is TSX; no markdown pipeline (decision 2026-10-12).
import { defineRoutes } from '@brust/core/routes'
import Layout from './components/Layout'
import DocsIndexPage from './pages/DocsIndexPage'
import HomePage from './pages/HomePage'
import NotFoundPage from './pages/NotFoundPage'

export const routes = defineRoutes([
  {
    Component: Layout,
    children: [
      { path: '/', Component: HomePage },
      { path: '/docs', Component: DocsIndexPage },
    ],
  },
  // Outside the layout: a static full document, no scripts.
  { path: '*', Component: NotFoundPage },
])
