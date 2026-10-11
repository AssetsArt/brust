import { defineRoutes } from '../../../runtime/routes.ts'
import AppLayout from './components/AppLayout'
import { dexLoader, teamLoader, typesLoader } from './lib/loaders'
import DexPage from './pages/DexPage'
import TeamPage from './pages/TeamPage'
import TypesPage from './pages/TypesPage'

// Same three pages, 0.1.x conventions: every route native, /types L1-cached 1 h; /dex and /team never cached
// (0.1.x has no ?nocache contract here — the probe's query is simply ignored, see spec §1.2).
export const routes = defineRoutes([
  {
    Component: AppLayout,
    native: true,
    children: [
      { path: '/types', Component: TypesPage, native: true, loader: typesLoader, cache: { ttl_seconds: 3600 } },
      { path: '/dex', Component: DexPage, native: true, loader: dexLoader },
      { path: '/team', Component: TeamPage, native: true, loader: teamLoader },
    ],
  },
])
