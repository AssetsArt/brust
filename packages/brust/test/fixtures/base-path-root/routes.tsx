// F495 fixture: the app at the root of the shared origin (no base_path). Its output must be the bytes it always was.
import { defineRoutes } from '@brust/core/routes'
import About from './About'
import Home from './Home'
import Layout from './Layout'

export const routes = defineRoutes([
  {
    Component: Layout,
    children: [
      { path: '/', Component: Home },
      { path: '/about', Component: About },
    ],
  },
])
