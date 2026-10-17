import { defineRoutes } from '@brust/core/routes'
import P_rows from './p_rows'
import P_clone from './p_clone'
import P_child from './p_child'
import P_whole from './p_whole'
export const routes = defineRoutes([
  { path: '/rows', Component: P_rows },
  { path: '/clone', Component: P_clone },
  { path: '/child', Component: P_child },
  { path: '/whole', Component: P_whole },
])
