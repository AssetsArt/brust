import { defineRoutes } from 'brustjs/routes'
import Home from './pages/Home'

export const routes = defineRoutes([
  { path: '/', Component: Home },
])
