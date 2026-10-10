// bench/apps/brust/routes.tsx — three probes: S cacheable (L1 1 h), D and I bypass L1 on ?nocache=1 (the bench
// measures the MISS path: loader every request, jobs from the job cache, Counter ssr job + hydration tags).
import { defineRoutes } from '@brust/core/routes'
import Layout from './components/Layout'
import { dexLoader, teamLoader, typesLoader } from './lib/loaders'
import DexPage from './pages/DexPage'
import TeamPage from './pages/TeamPage'
import TypesPage from './pages/TypesPage'

export const routes = defineRoutes([
  {
    Component: Layout,
    children: [
      { path: '/types', Component: TypesPage, loader: typesLoader, cache: { ttl_seconds: 3600, tags: ['types'] } },
      { path: '/dex', Component: DexPage, loader: dexLoader, cache: { ttl_seconds: 60, bypass: 'query(nocache)', tags: ['dex'] } },
      { path: '/team', Component: TeamPage, loader: teamLoader, cache: { ttl_seconds: 60, bypass: 'query(nocache)', tags: ['team'] } },
    ],
  },
])
