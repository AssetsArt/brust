// Manifest shapes the main fixture does not reach: component cache(), a react child per row
// (ssr job with per_instance), a client_only react child (static children[] entry, no ssr job).
import { defineRoutes } from '@brust/brust/routes'
import ListPage from './ListPage'

export const routes = defineRoutes([
  { path: '/list', Component: ListPage, loader: async () => ({ page: { id: 'p1' }, items: [{ id: 'a', name: 'Ann' }, { id: 'b', name: 'Bob' }] }) },
])
