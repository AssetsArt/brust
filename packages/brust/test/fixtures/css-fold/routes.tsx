// L20 fixture: CSS Module classes in a static page and in a native page fold to literals.
import { defineRoutes } from '@brust/core/routes'
import Native from './Native'
import Static from './Static'

export const routes = defineRoutes([
  { path: '/', Component: Static },
  { path: '/native', Component: Native },
])
