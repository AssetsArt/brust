import { defineRoutes } from '@brust/core/routes'
import GatePage from './GatePage'
import Nested from './Nested'
import NestedIds from './NestedIds'
import InputsPage from './InputsPage'
import Page from './Page'
import RenderPage from './RenderPage'
import PolyPage from './PolyPage'

export const routes = defineRoutes([
  { path: '/', Component: Page },
  { path: '/nested', Component: Nested },
  { path: '/nested-ids', Component: NestedIds },
  { path: '/gate', Component: GatePage },
  { path: '/inputs', Component: InputsPage },
  { path: '/render', Component: RenderPage },
  { path: '/poly', Component: PolyPage },
])
