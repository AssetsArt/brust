// F461 fixture: the built-in `navigation` store read by a native layout component, by a layout island and by a page
// island. `/slow` waits 700 ms in its loader so a test can look at the page while a navigation is loading.
import { defineRoutes } from '@brust/core/routes'
import Home from './Home'
import IslandPage from './IslandPage'
import NotFound from './NotFound'
import Other from './Other'
import Shell from './Shell'
import Slow from './Slow'

export const routes = defineRoutes([
  {
    Component: Shell,
    children: [
      { path: '/', Component: Home },
      { path: '/other', Component: Other },
      { path: '/island', Component: IslandPage },
      {
        path: '/slow',
        Component: Slow,
        loader: async () => {
          await new Promise((r) => setTimeout(r, 700))
          return {}
        },
      },
      { path: '*', Component: NotFound },
    ],
  },
])
