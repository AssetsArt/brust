import { defineRoutes } from '@brust/brust/routes'
import SecIsland from './SecIsland'

export const routes = defineRoutes([{ path: '/', Component: SecIsland }])
