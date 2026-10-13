import { defineRoutes } from '@brust/core/routes'
import Page from './page-static'
export const routes = defineRoutes([{ path: '/', Component: Page }])
