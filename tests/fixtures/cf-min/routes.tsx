import { defineRoutes, redirect } from '@brust/core/routes'
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
  // F464: res.headers on the Workers host (the same pipeline): two cookies on a redirect, a no-store page on a cached route
  {
    path: '/out',
    Component: Item,
    loader: ({ res }) => {
      res.headers.append('Set-Cookie', 'a=1; Path=/')
      res.headers.append('Set-Cookie', 'b=2; Path=/')
      return redirect('/', 303)
    },
  },
  {
    path: '/private/{id}',
    Component: Item,
    loader: ({ params, res }) => {
      res.headers.set('Cache-Control', 'no-store')
      return { item: { id: params.id, price: Number(params.id) } }
    },
    cache: { ttl_seconds: 60 },
  },
  {
    path: '/raw/{kind}',
    Component: Raw,
    loader: ({ params }) => ({
      h: params.kind === 'null' ? null : params.kind === 'num' ? 7 : '<b>x</b>',
      t: '<b>x</b>',
    }),
  },
])
