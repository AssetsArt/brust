import { defineRoutes } from '@brust/core/routes'
import { box } from './data'
import Page from './Page'

export const routes = defineRoutes([{ path: '/', Component: Page, loader: async () => ({ box }) }])
