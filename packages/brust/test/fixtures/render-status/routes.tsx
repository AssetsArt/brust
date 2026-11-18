// F552 fixture: a loader renders the route's page at a 4xx/5xx status with renderStatus(), as notFound() does at 404:
// the layout's data stays, the loader's headers apply, the page is never stored although the route is cached. A native
// page and a React-tier page.
import { defineRoutes, notFound, renderStatus } from '@brust/core/routes'
import Leaf from './Leaf'
import ReactLeaf from './ReactLeaf'
import Root from './Root'

const cache = { ttl_seconds: 60 }

export const routes = defineRoutes([
  {
    Component: Root,
    loader: () => ({ user: 'ann' }),
    children: [
      { path: '/', Component: Leaf, loader: () => ({ title: 'home' }), cache },
      {
        path: '/forbidden',
        Component: Leaf,
        loader: ({ res }) => {
          res.headers.set('X-Why', 'denied')
          return renderStatus(403, { title: 'forbidden', why: 'no access' })
        },
        cache,
      },
      { path: '/down', Component: Leaf, loader: () => renderStatus(503, { title: 'down', why: 'maintenance' }), cache },
      { path: '/gone', Component: Leaf, loader: () => notFound({ title: 'gone' }), cache },
      {
        path: '/react-forbidden',
        Component: ReactLeaf,
        loader: ({ res }) => {
          res.headers.set('X-Why', 'denied')
          return renderStatus(403, { title: 'react-forbidden', why: 'no access' })
        },
        cache,
      },
    ],
  },
])
