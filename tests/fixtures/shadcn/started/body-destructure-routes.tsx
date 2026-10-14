import { defineRoutes } from '@brust/core/routes'
import Page from './body-destructure/Page'

export const routes = defineRoutes([{ path: '/', Component: Page }])
