// L19 fixture: [css] global, a layout CSS import (with @import and nesting), page CSS, a CSS Module
// shared by two pages, a native page and two React islands (hydrated and client_only) with modules.
import { defineRoutes } from '@brust/core/routes'
import Home from './Home'
import Islands from './Islands'
import Layout from './Layout'
import Native from './Native'
import Other from './Other'

export const routes = defineRoutes([
  {
    Component: Layout,
    children: [
      { path: '/', Component: Home },
      { path: '/other', Component: Other },
      { path: '/native', Component: Native },
      { path: '/islands', Component: Islands },
    ],
  },
  { path: '/bare', Component: Other },
])
