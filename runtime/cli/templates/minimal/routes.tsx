import { defineRoutes } from 'brustjs/routes'
import Home from './pages/Home'

export const routes = defineRoutes([
  // React SSR page with a client island and a server (SSR) island — see pages/Home.tsx.
  { path: '/', Component: Home },
] as const)
