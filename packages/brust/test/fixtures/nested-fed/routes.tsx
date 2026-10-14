import { defineRoutes } from '@brust/core/routes'
import Page from './Page'
import Chain from './Chain'
import Order from './Order'

export const routes = defineRoutes([
  { path: '/', Component: Page },
  { path: '/chain', Component: Chain },
  { path: '/order', Component: Order },
])
