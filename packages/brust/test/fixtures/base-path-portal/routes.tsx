// F495 fixture: the same origin's second app, mounted under /portal. Every route is a real URL path written with the base.
import { defineRoutes } from '@brust/core/routes'
import About from './About'
import Home from './Home'
import Layout from './Layout'
import Order from './Order'

export const routes = defineRoutes([
  {
    Component: Layout,
    children: [
      {
        path: '/portal',
        children: [
          { path: '/', Component: Home },
          { path: '/about', Component: About },
          { path: '/orders/{id}', Component: Order, loader: ({ params }) => ({ id: params.id }) },
        ],
      },
    ],
  },
])
