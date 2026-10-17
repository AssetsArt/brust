import { defineRoutes } from '@brust/core/routes'
import P_const from './p_const'
import P_gate from './p_gate'
import P_handler from './p_handler'
import P_ifmount from './p_ifmount'
import P_linked from './p_linked_child'
import P_linked_static from './p_linked_static'
import P_list from './p_list'
import P_livewrap from './p_livewrap'
import P_nested from './p_nested'
import P_prop from './p_prop'
import P_rest from './p_rest'
import P_rows from './p_rows'
import P_rows_free from './p_rows_free'
import P_scoped from './p_scoped'
import P_state from './p_state'
import P_switch from './p_switch'
import P_text from './p_text'
import P_two_levels from './p_two_levels'
export const routes = defineRoutes([
  { path: '/const', Component: P_const },
  { path: '/gate', Component: P_gate },
  { path: '/handler', Component: P_handler },
  { path: '/ifmount', Component: P_ifmount },
  { path: '/linked', Component: P_linked },
  { path: '/linked_static', Component: P_linked_static },
  { path: '/list', Component: P_list },
  { path: '/livewrap', Component: P_livewrap },
  { path: '/nested', Component: P_nested },
  { path: '/prop', Component: P_prop },
  { path: '/rest', Component: P_rest },
  { path: '/rows', Component: P_rows },
  { path: '/rows_free', Component: P_rows_free },
  { path: '/scoped', Component: P_scoped },
  { path: '/state', Component: P_state },
  { path: '/switch', Component: P_switch },
  { path: '/text', Component: P_text },
  { path: '/two_levels', Component: P_two_levels },
])
