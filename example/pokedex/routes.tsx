import { defineRoutes } from 'brustjs/routes'
import AppLayout from './components/AppLayout'
import { detailLoader, listLoader, typeChartLoader } from './lib/loaders'
import DetailPage from './pages/DetailPage'
import ListPage from './pages/ListPage'
import TypeChart from './pages/TypeChart'

// Every route is `native: true` — each page is compiled from JSX to a minijinja
// template at build time and rendered in Rust (no per-request React). The loader
// runs in a Bun worker and its return value becomes the template scope. The only
// React that ever boots in the browser is the islands (TeamBuilder /
// AddToTeamButton). See ./FRAMEWORK-GAPS.md for what this costs.
//
// ROUTER-LEVEL LAYOUT (Approach a): the chrome (sidebar / topbar / team-dock) is
// written ONCE in AppLayout, nested as the parent of the three leaf routes. Each
// leaf renders into AppLayout's <Outlet/> slot. The compiler builds the synth
// wrapper `<AppLayout native><Leaf native/></AppLayout>` per leaf and runs the
// chain loaders top-down, shallow-merging into one flat jinja context. The leaf
// loaders therefore also return the chrome fields (title/active/crumb/teamProps)
// that AppLayout reads — see lib/loaders.ts and components/AppLayout.tsx.
export const routes = defineRoutes([
  {
    Component: AppLayout,
    native: true,
    children: [
      // List + pagination (query string via req.search, validated by hand in the loader).
      { path: '/', Component: ListPage, native: true, loader: listLoader },

      // Dynamic param {name} + a (non-streamed) evolution chain loaded in the loader.
      { path: '/pokemon/{name}', Component: DetailPage, native: true, loader: detailLoader },

      // Static 18×18 effectiveness matrix — the ideal native page.
      { path: '/type-chart', Component: TypeChart, native: true, loader: typeChartLoader },
    ],
  },
])
