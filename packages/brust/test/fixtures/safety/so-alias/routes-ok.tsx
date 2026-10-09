import { defineRoutes } from '@brust/core/routes'
import OkIsland from './OkIsland'

export const routes = defineRoutes([{ path: '/', Component: OkIsland }])
