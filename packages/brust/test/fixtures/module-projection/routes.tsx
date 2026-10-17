import { defineRoutes } from '@brust/core/routes'
import P_rows from './p_rows'
import P_clone from './p_clone'
import P_child from './p_child'
import P_whole from './p_whole'
import P_ref from './p_ref'
import P_refd from './p_refd'
import P_import from './p_import'
export const routes = defineRoutes([
  { path: '/rows', Component: P_rows },
  { path: '/clone', Component: P_clone },
  { path: '/child', Component: P_child },
  { path: '/whole', Component: P_whole },
  { path: '/ref', Component: P_ref },
  { path: '/refd', Component: P_refd },
  { path: '/import', Component: P_import },
])
