import { defineRoutes } from '@brust/core/routes'
import POuter from './p_outer'
import PReorder from './p_reorder'
import PRepro from './p_repro'

export const routes = defineRoutes([
  { path: '/repro', Component: PRepro },
  { path: '/reorder', Component: PReorder },
  { path: '/outer', Component: POuter },
])
