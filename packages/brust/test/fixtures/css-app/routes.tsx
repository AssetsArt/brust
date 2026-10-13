// L19 fixture: [css] global, a layout CSS import (with @import and nesting), page CSS, a CSS Module
// shared by two pages (composing a class from another module), a native page, two React islands
// (hydrated and client_only) with modules, and CSS reached only through a dynamic import().
import { defineRoutes } from '@brust/core/routes'
import Home from './Home'
import Islands from './Islands'
import Layout from './Layout'
import LazyPage from './LazyPage'
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
      { path: '/lazy', Component: LazyPage },
    ],
  },
  { path: '/bare', Component: Other },
])
