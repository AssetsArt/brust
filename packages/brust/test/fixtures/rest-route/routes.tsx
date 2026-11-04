import { defineRoutes } from '@brust/core/routes'
import Home from './Home'
import { restLoader } from './loaders'
import RestPage from './RestPage'

export const routes = defineRoutes([
  { path: '/', Component: Home },
  { path: '/docs/{*rest}', Component: RestPage, loader: restLoader },
])
