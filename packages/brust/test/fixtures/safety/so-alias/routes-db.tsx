import { defineRoutes } from '@brust/brust/routes'
import DbIsland from './DbIsland'

export const routes = defineRoutes([{ path: '/', Component: DbIsland }])
