import { defineRoutes } from '@brust/core/routes'
import P_const from './p_const'
import P_wrap from './p_wrap'
export const routes = defineRoutes([
  { path: '/const', Component: P_const },
  { path: '/wrap', Component: P_wrap },
])
