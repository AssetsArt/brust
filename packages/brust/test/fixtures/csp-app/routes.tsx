// F539 fixture: every inline script brust writes (base path, actions prefix) must pass the hash-only policy; the island
// calls an action through `client()`; /shop/slow keeps a navigation loading long enough to show the progress bar.
import { defineRoutes } from '@brust/core/routes'
import About from './About'
import Home from './Home'
import Layout from './Layout'
import Styled from './Styled'

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
            Component: About,
            loader: async () => {
              await Bun.sleep(600)
              return {}
            },
          },
          { path: '/styled', Component: Styled },
        ],
      },
    ],
  },
])
