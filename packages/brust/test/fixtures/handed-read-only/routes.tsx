import { defineRoutes } from '@brust/core/routes'
import { checkLook } from './lib/doc'
import Page from './Page'

export const routes = defineRoutes([
  {
    path: '/',
    Component: Page,
    loader: () => ({ show: checkLook({ a: 1 }) === null, items: [{ type: 'list', id: 'l1' }] }),
  },
])
