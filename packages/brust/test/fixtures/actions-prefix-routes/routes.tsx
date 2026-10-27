// Page and loader routes under the actions prefix (F470, Assets Art B-12): an OAuth GET callback under /auth is a loader
// route that sets the session cookie and redirects; the same path's POST (Apple form_post) is the actions app's.
import { defineRoutes, redirect } from '@brust/core/routes'
import Leaf from './Leaf'
import Root from './Root'

export const routes = defineRoutes([
  {
    Component: Root,
    children: [
      { path: '/', Component: Leaf, loader: () => ({ name: 'home' }) },
      {
        path: '/auth/{provider}/callback',
        Component: Leaf,
        loader: ({ params, req, res }) => {
          res.headers.append('Set-Cookie', `sid=${params.provider}-${req.search.code ?? 'none'}; Path=/; HttpOnly; SameSite=Lax`)
          return redirect('/', 303)
        },
      },
      { path: '/auth/done', Component: Leaf, loader: () => ({ name: 'auth-done' }) },
      { path: '*', Component: Leaf, loader: () => ({ name: 'not-found' }) },
    ],
  },
])
