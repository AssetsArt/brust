import { defineRoutes } from '@brust/core/routes'
import Nested from './Nested'
import NestedIds from './NestedIds'
import Page from './Page'

export const routes = defineRoutes([
  { path: '/', Component: Page },
  { path: '/nested', Component: Nested },
  { path: '/nested-ids', Component: NestedIds },
])
