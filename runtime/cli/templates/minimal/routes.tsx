import { defineRoutes } from 'brust/routes'
import Home from './pages/Home'

export const routes = defineRoutes([
  { path: '/', Component: Home },
])
