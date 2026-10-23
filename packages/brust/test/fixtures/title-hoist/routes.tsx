import { defineRoutes } from '@brust/core/routes'
import About from './About'
import Home from './Home'
import Layout from './Layout'
import Plain from './Plain'

export const routes = defineRoutes([
  {
    Component: Layout,
    children: [
      { path: '/', Component: Home },
      { path: '/about', Component: About },
      { path: '/plain', Component: Plain },
    ],
  },
])
