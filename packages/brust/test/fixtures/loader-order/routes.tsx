import { defineRoutes } from '@brust/core/routes'
import { variant } from './data'
import Page from './Page'

export const routes = defineRoutes([{ path: '/', Component: Page, loader: async ({ req }) => ({ box: variant(req.search.o ?? null) }) }])
