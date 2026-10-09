import { defineRoutes } from '@brust/core/routes'
import Island from './Island'

export const routes = defineRoutes([{ path: '/', Component: Island }])
