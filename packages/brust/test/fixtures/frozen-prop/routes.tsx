import { defineRoutes } from '@brust/core/routes'
import PChain from './p_chain'
import PMore from './p_more'
import PProv from './p_prov'
import PDirect from './p_direct'
import PStatic from './p_static'
import PRest from './p_rest'
import PSpread from './p_spread'
import PRestUp from './p_restup'
import PCond from './p_cond'

export const routes = defineRoutes([
  { path: '/chain', Component: PChain },
  { path: '/prov', Component: PProv },
  { path: '/more', Component: PMore },
  { path: '/direct', Component: PDirect },
  { path: '/static', Component: PStatic },
  { path: '/rest', Component: PRest },
  { path: '/spread', Component: PSpread },
  { path: '/restup', Component: PRestUp },
  { path: '/cond', Component: PCond },
])
