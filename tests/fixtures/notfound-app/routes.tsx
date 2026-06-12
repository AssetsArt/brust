import { defineRoutes } from '../../../runtime/routes.ts'
import Home from './Home'
import NotFoundPage from './NotFoundPage'

// A real route `/` plus a global catch-all (`path: '*'`). The catch-all stays
// in the flat array (route_id stable) flagged `notFound`; on an unmatched path
// the Rust router's not-found tier selects it and renders it at HTTP 404.
export const routes = defineRoutes([
  { path: '/', Component: Home },
  { path: '*', Component: NotFoundPage },
])
