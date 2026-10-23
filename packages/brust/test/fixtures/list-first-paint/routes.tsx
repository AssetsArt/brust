import { defineRoutes } from '@brust/core/routes'
import PEmpty from './p_empty'
import PNoindex from './p_noindex'
import PPanel from './p_panel'
import PReorder from './p_reorder'
import PRepro from './p_repro'
import PStepper from './p_stepper'

export const routes = defineRoutes([
  { path: '/repro', Component: PRepro },
  { path: '/noindex', Component: PNoindex },
  { path: '/reorder', Component: PReorder },
  { path: '/stepper', Component: PStepper },
  { path: '/panel', Component: PPanel },
  { path: '/empty', Component: PEmpty },
])
