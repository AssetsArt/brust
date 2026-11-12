// F544 fixture: under default-src 'none' brust names what it loads itself; the island calls an action and opens a
// WebSocket (an actions .ws route), /shop/slow keeps a navigation loading, /shop/forms posts to the actions prefix.
import { defineRoutes } from '@brust/core/routes'
import Forms from './Forms'
import Home from './Home'
import Layout from './Layout'
import Slow from './Slow'

export const routes = defineRoutes([
  {
    Component: Layout,
    children: [
      {
        path: '/shop',
        children: [
          { path: '/', Component: Home },
          {
            path: '/slow',
            Component: Slow,
            loader: async () => {
              await Bun.sleep(600)
              return {}
            },
          },
          { path: '/forms', Component: Forms },
        ],
      },
    ],
  },
])
