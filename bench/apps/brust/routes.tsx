import { defineRoutes } from '../../../runtime/routes.ts'

import HelloWorld from '../_shared/HelloWorld'
import NativeProfile from './pages/NativeProfile'
import NativeIslands from './pages/NativeIslands'

/** Benchmark route table — one route per `scripts/benchmark.ts` PROBE.
 * Intentionally minimal: no SSE/WS/Suspense/blog routes (the bench doesn't
 * probe them, and dead routes would only add boot cost + drift risk). */
export const routes = defineRoutes([
  // React SSR — same `/` workload the bun-serve baseline renders
  // (it imports the same `_shared/HelloWorld`), so the comparison is fair.
  { path: '/', Component: HelloWorld },

  // Native (jinja) route, no islands — the no-island fast-lane floor.
  {
    path: '/native-profile/{user}',
    Component: NativeProfile,
    native: true,
    loader: async ({ params }) => ({
      user: params.user,
      greeting: `Welcome, ${params.user}`,
    }),
  },

  // Native route WITH islands — one client-only island (props string only) +
  // one server island (renderToString in the loader crossing). Delta vs
  // /native-profile ≈ the ssr island's render cost.
  {
    path: '/native-islands',
    Component: NativeIslands,
    native: true,
    loader: async () => ({
      greeting: 'Islands on a native route',
      clientProps: { start: 0, label: 'client clicks' },
      serverProps: { start: 100, label: 'server clicks' },
    }),
  },
])
