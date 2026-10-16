import { defineRoutes } from '@brust/core/routes'
import DestructuredPage from './DestructuredPage'
import WholePage from './WholePage'

export const routes = defineRoutes([
  { path: '/whole', Component: WholePage },
  { path: '/destructured', Component: DestructuredPage },
])
