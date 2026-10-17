import { defineRoutes } from '@brust/core/routes'
import P_two from './p_two'
import P_two_on from './p_two_on'
import P_same_loc from './p_same_loc'
import P_same_loc3 from './p_same_loc3'
export const routes = defineRoutes([
  { path: '/two', Component: P_two },
  { path: '/two_on', Component: P_two_on },
  { path: '/same_loc', Component: P_same_loc },
  { path: '/same_loc3', Component: P_same_loc3 },
])
