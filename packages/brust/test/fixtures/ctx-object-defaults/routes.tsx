import { defineRoutes } from '@brust/core/routes'
import DestructurePage from './DestructurePage'
import FieldPage from './FieldPage'
import InlinePage from './InlinePage'
import NestedPage from './NestedPage'
import OverridePage from './OverridePage'

export const routes = defineRoutes([
  { path: '/field', Component: FieldPage },
  { path: '/destructure', Component: DestructurePage },
  { path: '/override', Component: OverridePage },
  { path: '/nested', Component: NestedPage },
  { path: '/inline', Component: InlinePage },
])
