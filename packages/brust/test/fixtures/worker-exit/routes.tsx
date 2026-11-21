import { defineRoutes } from '@brust/core/routes'
import Page from './Page'

export const routes = defineRoutes([
  { path: '/ok', Component: Page, loader: () => ({ v: 'ok' }) },
  {
    path: '/exit',
    Component: Page,
    // The worker leaves while this call is in flight: its promise never settles.
    loader: () => {
      setTimeout(() => process.exit(7), 100)
      return new Promise(() => {})
    },
  },
])
