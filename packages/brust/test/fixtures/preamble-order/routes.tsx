import { defineRoutes } from '@brust/core/routes'
import ImportedPage from './ImportedPage'
import LocalPage from './LocalPage'
import SeedPage from './SeedPage'

export const routes = defineRoutes([
  { path: '/local', Component: LocalPage },
  { path: '/imported', Component: ImportedPage },
  { path: '/seed', Component: SeedPage },
])
