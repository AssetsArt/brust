import { defineRoutes } from '@brust/brust/routes'
import Island from './Island'

export const routes = defineRoutes([{ path: '/', Component: Island }])
