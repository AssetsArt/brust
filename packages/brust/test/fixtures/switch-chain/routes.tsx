import { defineRoutes } from '@brust/core/routes'
import P_bare from './p_bare'
import P_const from './p_const'
import P_rows from './p_rows'
import P_rows_bare from './p_rows_bare'
import P_thumb from './p_thumb'
export const routes = defineRoutes([
  { path: '/bare', Component: P_bare },
  { path: '/const', Component: P_const },
  { path: '/rows', Component: P_rows },
  { path: '/rows_bare', Component: P_rows_bare },
  { path: '/thumb', Component: P_thumb },
])
