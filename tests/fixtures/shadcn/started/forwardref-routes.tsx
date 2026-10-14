import { defineRoutes } from '@brust/core/routes'
import Page from './forwardref/Page'

export const routes = defineRoutes([{ path: '/', Component: Page }])
