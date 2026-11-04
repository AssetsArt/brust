// F495 fixture: a route outside base_path never gets a request (the server answers 404 outside it): the build says so.
import { defineRoutes } from '@brust/core/routes'
import Home from './Home'

export const routes = defineRoutes([
  { path: '/portal', Component: Home },
  { path: '/', Component: Home },
  { path: '/other/{id}', Component: Home },
])
