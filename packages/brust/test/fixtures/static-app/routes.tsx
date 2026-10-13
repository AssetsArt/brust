// `brust build --target static` fixture (gaps round L9): static pages, a dynamic route with
// ssg.params (a `%` and a Thai value), a redirect, an opted-out route, a loader that reads the
// request, a React island and the * route. `/go/ไทย` pins a non-ASCII redirect source (review N4).
import { defineRoutes, redirect } from '@brust/core/routes'
import Docs from './Docs'
import Home from './Home'
import Layout from './Layout'
import NotFound from './NotFound'
import Poke from './Poke'
import Reads from './Reads'

export const POKEMON = ['pikachu', '100%', 'ไทย']

export const routes = defineRoutes([
  {
    Component: Layout,
    children: [
      { path: '/', Component: Home },
      { path: '/docs', Component: Docs, loader: () => ({ title: 'Docs' }) },
      { path: '/docs/intro', Component: Docs, loader: () => ({ title: 'Intro' }) },
      {
        path: '/poke/{name}',
        Component: Poke,
        loader: ({ params }) => ({ name: params.name }),
        ssg: { params: () => POKEMON.map((name) => ({ name })) },
      },
      { path: '/old', Component: Home, loader: () => redirect('/docs', 301) },
      { path: '/go/{to}', Component: Home, loader: () => redirect('/docs/intro', 302), ssg: { params: () => [{ to: 'ไทย' }] } },
      { path: '/live/{id}', Component: Home, ssg: false },
      { path: '/reads', Component: Reads, loader: ({ req }) => ({ theme: req.cookies.theme ?? 'none' }) },
      { path: '*', Component: NotFound },
    ],
  },
])
