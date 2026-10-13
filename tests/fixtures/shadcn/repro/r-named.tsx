import { defineRoutes } from '@brust/core/routes'
import Page from './page-named'
export const routes = defineRoutes([{ path: '/', Component: Page }])
