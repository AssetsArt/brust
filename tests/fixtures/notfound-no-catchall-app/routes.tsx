import { defineRoutes, notFound } from '../../../runtime/routes.ts'
import Item from './Item'

// A React `/items/{id}` route whose loader always `throw notFound()`, and NO
// catch-all registered. The React notFound() trigger must serve the framework
// default 404 body at HTTP 404 (no catch-all to render).
export const routes = defineRoutes([
  {
    path: '/items/{id}',
    Component: Item,
    loader: async () => {
      throw notFound()
    },
  },
])
