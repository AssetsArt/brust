import { defineRoutes } from '@brust/core/routes'
import Home from './pages/Home'
import Island from './pages/Island'
import Item from './pages/Item'
import Raw from './pages/Raw'

export const routes = defineRoutes([
  { path: '/', Component: Home },
  {
    path: '/items/{id}',
    Component: Item,
    loader: ({ params }) => ({ item: { id: params.id, price: Number(params.id) } }),
    cache: { ttl_seconds: 60, tags: ['items'] },
  },
  { path: '/island', Component: Island },
  {
    path: '/raw/{kind}',
    Component: Raw,
    loader: ({ params }) => ({
      h: params.kind === 'null' ? null : params.kind === 'num' ? 7 : '<b>x</b>',
      t: '<b>x</b>',
    }),
  },
])
