import { defineRoutes } from '@brust/core/routes'
import P_state from './p_state'
import P_static from './p_static'
import P_strict from './p_strict'

export const routes = defineRoutes([
  { path: '/static', Component: P_static },
  { path: '/strict', Component: P_strict },
  { path: '/state', Component: P_state },
])
