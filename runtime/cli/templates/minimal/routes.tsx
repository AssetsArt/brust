import { defineRoutes } from 'brustjs/routes'
import Home from './pages/Home'

export const routes = defineRoutes([
  // `native: true` — Home is compiled to a jinja template and rendered in Rust
  // (no React on the server). The loader's return value is the template
  // context; each island's `props` is a path into it.
  //
  // `cacheKey`/`cacheTags` feed the server island's `isr` cache: with a stable
  // key its renderToString runs once and later requests serve the frozen markup
  // from Rust. In a real app derive the key from the data the island depends on
  // (e.g. `product:${id}`) and invalidate by tag when that data changes.
  {
    path: '/',
    Component: Home,
    native: true,
    loader: async () => ({
      clientProps: { start: 0, label: 'client clicks' },
      serverProps: { start: 100, label: 'server clicks' },
      cacheKey: 'home:server-island',
      cacheTags: ['home'],
    }),
  },
] as const)
