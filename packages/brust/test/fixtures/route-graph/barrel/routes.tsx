import { defineRoutes } from '@brust/core/routes'
import { Page } from './pages'

export const routes = defineRoutes([{ path: '/', Component: Page }])
