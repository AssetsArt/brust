import { defineRoutes } from '@brust/core/routes'
import KeyPage from './KeyPage'
import KeySpreadPage from './KeySpreadPage'

export const routes = defineRoutes([
  { path: '/key', Component: KeyPage },
  { path: '/key-spread', Component: KeySpreadPage },
])
