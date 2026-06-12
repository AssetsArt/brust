import { defineRoutes, notFound } from '../../../runtime/routes.ts'
import Home from './Home'
import Item from './Item'
import NotFoundPage from './NotFoundPage'

// A real route `/`, a React `/items/{id}` route whose loader can `throw
// notFound()`, plus a global catch-all (`path: '*'`). The catch-all stays in
// the flat array (route_id stable) flagged `notFound`; on an unmatched path the
// Rust router's not-found tier selects it and renders it at HTTP 404. A React
// loader `throw notFound()` is discriminated in the render dispatch and renders
// the SAME nearest catch-all at HTTP 404 (parity with the native verdict).
export const routes = defineRoutes([
  { path: '/', Component: Home },
  {
    path: '/items/{id}',
    Component: Item,
    loader: async ({ params }) => {
      // Only `ok` exists; anything else → throw notFound() → nearest catch-all @ 404.
      if (params.id !== 'ok') throw notFound()
      return { id: params.id }
    },
  },
  { path: '*', Component: NotFoundPage },
])
