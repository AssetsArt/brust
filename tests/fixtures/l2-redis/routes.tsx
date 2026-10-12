import { defineRoutes } from '@brust/core/routes'
import Item from './pages/Item'

export const routes = defineRoutes([
  {
    path: '/items/{id}',
    Component: Item,
    loader: ({ params }) => ({ item: { id: params.id, n: Date.now() } }),
    cache: { ttl_seconds: 600, tags: ['items'] },
  },
  { path: '/plain/{id}', Component: Item, loader: ({ params }) => ({ item: { id: params.id, n: Date.now() } }) },
])
