import { defineRoutes } from '@brust/core/routes'
import Layout from './Layout'
import Page from './Page'

export const routes = defineRoutes([{ Component: Layout, children: [{ path: '/', Component: Page }] }])
