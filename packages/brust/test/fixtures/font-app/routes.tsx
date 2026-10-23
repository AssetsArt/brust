// F411 fixture: asset imports (a font, an image) give the served, hashed URL.
import { defineRoutes } from '@brust/core/routes'
import Island from './Island'
import Layout from './Layout'
import Native from './Native'
import Plain from './Plain'

export const routes = defineRoutes([
  {
    Component: Layout,
    children: [
      { path: '/', Component: Plain },
      { path: '/native', Component: Native },
      { path: '/island', Component: Island },
    ],
  },
])
