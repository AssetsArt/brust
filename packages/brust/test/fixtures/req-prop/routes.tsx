import { defineRoutes } from '@brust/core/routes'
import HomePage from './pages/HomePage'

export const routes = defineRoutes([{ path: '/', Component: HomePage }])
