// F468: every full document brust renders carries one `<meta name="generator" content="brust/<version>">`: a native page,
// a React-tier page, a page that wrote its own (the app's wins), and the * route's 404.
import { defineRoutes } from '@brust/core/routes'
import Home from './Home'
import Layout from './Layout'
import NotFound from './NotFound'
import Own from './Own'
import ReactPage from './ReactPage'

export const routes = defineRoutes([
  {
    Component: Layout,
    children: [
      { path: '/', Component: Home },
      { path: '/react', Component: ReactPage },
      { path: '/own', Component: Own },
      { path: '*', Component: NotFound },
    ],
  },
])
