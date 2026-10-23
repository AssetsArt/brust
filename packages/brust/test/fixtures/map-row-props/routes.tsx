import { defineRoutes } from '@brust/core/routes'
import PNested from './p_nested'
import PReorder from './p_reorder'
import PRepro from './p_repro'

export const routes = defineRoutes([
  { path: '/repro', Component: PRepro },
  { path: '/reorder', Component: PReorder },
  { path: '/nested', Component: PNested },
])
