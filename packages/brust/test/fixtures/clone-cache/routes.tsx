import { defineRoutes } from '@brust/core/routes'
import P_two from './p_two'
import P_two_on from './p_two_on'
import P_rest_text from './p_rest_text'
import P_rest_k from './p_rest_k'
import P_rest_on from './p_rest_on'
import P_same_loc from './p_same_loc'
import P_same_loc3 from './p_same_loc3'
import P_pdiv from './p_pdiv'
import P_outerk from './p_outerk'
import P_ownkp from './p_ownkp'
import P_beside from './p_beside'
import P_rest_empty from './p_rest_empty'
export const routes = defineRoutes([
  { path: '/two', Component: P_two },
  { path: '/two_on', Component: P_two_on },
  { path: '/rest_text', Component: P_rest_text },
  { path: '/rest_k', Component: P_rest_k },
  { path: '/rest_on', Component: P_rest_on },
  { path: '/same_loc', Component: P_same_loc },
  { path: '/same_loc3', Component: P_same_loc3 },
  { path: '/pdiv', Component: P_pdiv },
  { path: '/outerk', Component: P_outerk },
  { path: '/ownkp', Component: P_ownkp },
  { path: '/beside', Component: P_beside },
  { path: '/rest_empty', Component: P_rest_empty },
])
