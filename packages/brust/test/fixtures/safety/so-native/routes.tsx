import { defineRoutes } from '@brust/core/routes'
import Leak from './Leak'

export const routes = defineRoutes([{ path: '/', Component: Leak }])
