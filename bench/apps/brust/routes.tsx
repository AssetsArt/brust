import { defineRoutes } from '../../../runtime/routes.ts'

import HelloWorld from '../_shared/HelloWorld'
import NativeProfile from './pages/NativeProfile'
import NativeIslands from './pages/NativeIslands'
import NativeIslandsIsr from './pages/NativeIslandsIsr'

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

  // Same shape as /native-islands, but the ssr island is ISR-CACHED (stable
  // key). Its renderToString runs ONCE; every later request serves the frozen
  // pair from the Rust cache. Delta vs /native-islands ≈ the renderToString
  // cost the ISR cache removes from the per-request hot path.
  {
    path: '/native-islands-isr',
    Component: NativeIslandsIsr,
    native: true,
    loader: async () => ({
      greeting: 'ISR-cached island on a native route',
      clientProps: { start: 0, label: 'client clicks' },
      serverProps: { start: 100, label: 'server clicks' },
      cacheKey: 'bench:isr-island',
      cacheTags: ['bench'],
    }),
  },
])
