import { defineRoutes } from '@brust/core/routes'
import Guarded from './Guarded'
import Page from './Page'

export const routes = defineRoutes([
  { path: '/', Component: Page },
  { path: '/guarded', Component: Guarded },
])
