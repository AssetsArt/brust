import { defineRoutes } from '@brust/core/routes'
import FlipPage from './FlipPage'
import StaticPage from './StaticPage'
import ZeroPage from './ZeroPage'

export const routes = defineRoutes([
  { path: '/flip', Component: FlipPage },
  { path: '/zero', Component: ZeroPage },
  { path: '/static', Component: StaticPage },
])
