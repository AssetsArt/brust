import { defineRoutes } from '@brust/core/routes'
import { pageLoader } from './loaders.server'
import Page from './Page'

export const routes = defineRoutes([{ path: '/', Component: Page, loader: pageLoader }])
