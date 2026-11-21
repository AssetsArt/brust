import { defineRoutes } from '@brust/core/routes'
import Page from './Page'

// F604: the loader answers after a short random wait, so calls overlap, finish out of order and some are still in
// the worker when their client goes away.
export const routes = defineRoutes([
  {
    path: '/echo/{m}',
    Component: Page,
    loader: async ({ params }: any) => {
      await new Promise((r) => setTimeout(r, Math.random() * 8))
      return { m: params.m }
    },
  },
])
