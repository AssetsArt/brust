import { defineRoutes } from '@brust/core/routes'
import Item from './pages/Item'

let renders = 0

export const routes = defineRoutes([
  {
    path: '/items/{id}',
    Component: Item,
    loader: ({ params }) => ({ item: { id: params.id, r: ++renders } }),
    cache: { ttl_seconds: 600, tags: ['items'] },
  },
])
