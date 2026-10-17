import { defineRoutes } from '@brust/core/routes'
import CondPage from './CondPage'
import GatePage from './GatePage'

export const routes = defineRoutes([
  { path: '/cond', Component: CondPage },
  { path: '/gate', Component: GatePage },
])
