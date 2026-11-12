// F541 fixture: the base path makes brust write an inline script (hashed by the policy); Home holds a React island,
// About is a static chain; no '*' route, so the build writes the default 404.html.
import { defineRoutes } from '@brust/core/routes'
import About from './About'
import Home from './Home'
import Layout from './Layout'

export const routes = defineRoutes([
  {
    Component: Layout,
    children: [
      {
        path: '/site',
        children: [
          { path: '/', Component: Home },
          { path: '/about', Component: About },
        ],
      },
    ],
  },
])
