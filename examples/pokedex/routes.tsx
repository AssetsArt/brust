// examples/pokedex/routes.tsx
import { defineRoutes } from '@brust/core/routes'
import AppLayout from './components/AppLayout'
import { browseLoader, detailLoader, homeLoader, typeChartLoader } from './lib/loaders'
import BrowsePage from './pages/BrowsePage'
import DetailPage from './pages/DetailPage'
import HomePage from './pages/HomePage'
import NotFoundPage from './pages/NotFoundPage'
import TypeChart from './pages/TypeChart'

export const routes = defineRoutes([
  {
    Component: AppLayout,
    children: [
      { path: '/', Component: HomePage, loader: homeLoader },
      { path: '/pokedex', Component: BrowsePage, loader: browseLoader },
      // L1 for 60 s by tag; `?nocache=1` bypasses L1 (bench probe B measures the miss path).
      { path: '/pokemon/{name}', Component: DetailPage, loader: detailLoader, cache: { ttl_seconds: 60, tags: ['pokemon'], bypass: 'query(nocache)' } },
      { path: '/type-chart', Component: TypeChart, loader: typeChartLoader, cache: { ttl_seconds: 3600, tags: ['types'] } },
    ],
  },
  // Outside the layout on purpose (D3): a static full document → 0 Bun calls, no scripts.
  { path: '*', Component: NotFoundPage },
])
