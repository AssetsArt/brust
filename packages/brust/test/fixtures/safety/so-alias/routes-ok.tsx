import { defineRoutes } from '@brust/brust/routes'
import OkIsland from './OkIsland'

export const routes = defineRoutes([{ path: '/', Component: OkIsland }])
