import { defineRoutes } from '@brust/core/routes'
import Page from './Page'
import WithChildren from './WithChildren'

export const routes = defineRoutes([
  { path: '/', Component: Page },
  { path: '/children', Component: WithChildren },
])
