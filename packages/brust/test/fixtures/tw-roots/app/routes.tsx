import { defineRoutes } from '@brust/core/routes'
import Home from './Home'

export const routes = defineRoutes([{ path: '/', Component: Home }])
