import { defineRoutes } from 'brustjs/routes'
import AppLayout from './components/AppLayout'
import { browseLoader, detailLoader, homeLoader, typeChartLoader } from './lib/loaders'
import HomePage from './pages/HomePage'
import BrowsePage from './pages/BrowsePage'
import DetailPage from './pages/DetailPage'
import TypeChart from './pages/TypeChart'

// Every route is `native: true` — each page is compiled from JSX to a minijinja
// template at build time and rendered in Rust. The loader runs in a Bun worker
// and its return value becomes the template scope. The chrome (navbar / footer /
// team-dock) is written ONCE in AppLayout, nested as the parent of the four leaf
// routes; each leaf renders into AppLayout's <Outlet/> slot.
export const routes = defineRoutes([
  {
    Component: AppLayout,
    native: true,
    children: [
      { path: '/', Component: HomePage, native: true, loader: homeLoader },
      { path: '/pokedex', Component: BrowsePage, native: true, loader: browseLoader },
      { path: '/pokemon/{name}', Component: DetailPage, native: true, loader: detailLoader },
      { path: '/type-chart', Component: TypeChart, native: true, loader: typeChartLoader },
    ],
  },
])
