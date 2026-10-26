// Loader response headers (F464, the Assets Art B-3 needs): a layout that sends `no-store` for every page under it (and
// is cached by route config, which it must override), a logout that sets two cookies on a redirect, a page with a CSP,
// a page that sets a set-cookie on a cached route, a loader that tries to set a server-owned name, and a plain cached
// page as the control.
import { defineRoutes, redirect } from '@brust/core/routes'
import Leaf from './Leaf'
import Root from './Root'

const cache = { ttl_seconds: 60 }

export const routes = defineRoutes([
  {
    Component: Root,
    children: [
      { path: '/', Component: Leaf, loader: () => ({ name: 'home' }) },
      { path: '/public', Component: Leaf, loader: () => ({ name: 'public' }), cache },
      {
        loader: ({ res }) => {
          res.headers.set('Cache-Control', 'no-store')
          return {}
        },
        children: [
          { path: '/private/one', Component: Leaf, loader: () => ({ name: 'private-one' }), cache },
          { path: '/private/two', Component: Leaf, loader: () => ({ name: 'private-two' }), cache },
        ],
      },
      {
        path: '/logout',
        Component: Leaf,
        loader: ({ res }) => {
          res.headers.append('Set-Cookie', 'a=1; Path=/; SameSite=Lax')
          res.headers.append('Set-Cookie', 'b=2; Path=/; SameSite=Lax')
          res.headers.set('Referrer-Policy', 'no-referrer')
          res.headers.set('Cache-Control', 'no-store')
          return redirect('/', 303)
        },
      },
      {
        path: '/csp',
        Component: Leaf,
        loader: ({ res }) => {
          res.headers.set('Content-Security-Policy', "frame-ancestors 'none'")
          return { name: 'csp' }
        },
      },
      {
        path: '/cookie',
        Component: Leaf,
        loader: ({ res }) => {
          res.headers.append('Set-Cookie', 'seen=1; Path=/')
          return { name: 'cookie' }
        },
        cache,
      },
      {
        path: '/refused',
        Component: Leaf,
        loader: ({ res }) => {
          res.headers.set('Location', '/elsewhere')
          res.headers.set('X-Ok', '1')
          return { name: 'refused' }
        },
      },
    ],
  },
])
