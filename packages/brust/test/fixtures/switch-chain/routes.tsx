import { defineRoutes } from '@brust/core/routes'
import P_bare from './p_bare'
import P_thumb from './p_thumb'
export const routes = defineRoutes([
  { path: '/bare', Component: P_bare },
  { path: '/thumb', Component: P_thumb },
])
