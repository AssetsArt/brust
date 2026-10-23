import { defineRoutes } from '@brust/core/routes'
import Page from './Page'

export const routes = defineRoutes([
  { path: '/hidden', Component: Page, loader: async () => ({ shown: false }) },
  { path: '/shown', Component: Page, loader: async () => ({ shown: true }) },
])
