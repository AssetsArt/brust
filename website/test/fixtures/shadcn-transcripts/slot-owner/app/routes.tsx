import { defineRoutes } from '@brust/core/routes'
import P_const from './p_const'
import P_gate from './p_gate'
import P_handler from './p_handler'
import P_linked from './p_linked_child'
import P_linked_static from './p_linked_static'
import P_list from './p_list'
import P_state from './p_state'
import P_text from './p_text'
import P_two_levels from './p_two_levels'
export const routes = defineRoutes([
  { path: '/const', Component: P_const },
  { path: '/gate', Component: P_gate },
  { path: '/handler', Component: P_handler },
  { path: '/linked', Component: P_linked },
  { path: '/linked_static', Component: P_linked_static },
  { path: '/list', Component: P_list },
  { path: '/state', Component: P_state },
  { path: '/text', Component: P_text },
  { path: '/two_levels', Component: P_two_levels },
])
