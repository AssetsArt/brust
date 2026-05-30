import { defineRoutes } from 'brustjs/routes'
import Home from './pages/Home'

export const routes = defineRoutes([
  // `native: true` — Home is compiled to a jinja template and rendered in Rust
  // (no React on the server). The loader's return value is the template
  // context; each island's `props` is a path into it.
  {
    path: '/',
    Component: Home,
    native: true,
    loader: async () => ({
      clientProps: { start: 0, label: 'client clicks' },
      serverProps: { start: 100, label: 'server clicks' },
    }),
  },
] as const)
