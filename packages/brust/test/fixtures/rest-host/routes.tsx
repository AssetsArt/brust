import { defineRoutes } from '@brust/core/routes'
import P_const from './p_const'
import P_linked from './p_linked'
import P_mid from './p_mid'
import P_props from './p_props'
import P_rest from './p_rest'
export const routes = defineRoutes([
  { path: '/const', Component: P_const },
  { path: '/linked', Component: P_linked },
  { path: '/mid', Component: P_mid },
  { path: '/props', Component: P_props },
  { path: '/rest', Component: P_rest },
])
