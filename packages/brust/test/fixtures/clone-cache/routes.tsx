import { defineRoutes } from '@brust/core/routes'
import P_two from './p_two'
import P_two_on from './p_two_on'
import P_rest_text from './p_rest_text'
import P_rest_k from './p_rest_k'
import P_rest_on from './p_rest_on'
import P_same_loc from './p_same_loc'
import P_same_loc3 from './p_same_loc3'
export const routes = defineRoutes([
  { path: '/two', Component: P_two },
  { path: '/two_on', Component: P_two_on },
  { path: '/rest_text', Component: P_rest_text },
  { path: '/rest_k', Component: P_rest_k },
  { path: '/rest_on', Component: P_rest_on },
  { path: '/same_loc', Component: P_same_loc },
  { path: '/same_loc3', Component: P_same_loc3 },
])
