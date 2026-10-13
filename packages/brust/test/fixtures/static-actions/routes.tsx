// `--target static` + `[actions]` fixture (gaps round L12): two static pages, the * route, and an
// actions app under /api. Built by test/static-actions.test.ts and tests/cf/static-actions.test.ts.
import { defineRoutes } from '@brust/core/routes'
import Home from './Home'
import NotFound from './NotFound'

export const routes = defineRoutes([
  { path: '/', Component: Home },
  { path: '/about', Component: Home, loader: () => ({ title: 'About' }) },
  { path: '*', Component: NotFound },
])
