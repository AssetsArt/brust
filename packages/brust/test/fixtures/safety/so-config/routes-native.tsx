import { defineRoutes } from '@brust/brust/routes'
import Native from './Native'

export const routes = defineRoutes([{ path: '/', Component: Native }])
