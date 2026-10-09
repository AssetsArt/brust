import { defineRoutes } from '@brust/brust/routes'
import Leak from './Leak'

export const routes = defineRoutes([{ path: '/', Component: Leak }])
