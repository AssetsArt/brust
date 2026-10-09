import { defineRoutes } from '@brust/core/routes'
import DbIsland from './DbIsland'

export const routes = defineRoutes([{ path: '/', Component: DbIsland }])
