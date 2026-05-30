import { defineRoutes } from 'brustjs/routes'
import Home from './pages/Home'
import NativeHello from './pages/NativeHello'

export const routes = defineRoutes([
  // React SSR page with a client island and a server (SSR) island — see pages/Home.tsx.
  { path: '/', Component: Home },

  // `native: true` route — compiled to a jinja template and rendered in Rust,
  // no React on the server. The loader's return value becomes `data`.
  {
    path: '/native/{name}',
    Component: NativeHello,
    native: true,
    loader: async ({ params }) => ({ name: params.name }),
  },
] as const)
