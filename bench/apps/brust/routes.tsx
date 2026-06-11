import { defineRoutes } from '../../../runtime/routes.ts'

import HelloWorld from '../_shared/HelloWorld'
import NativeProfile from './pages/NativeProfile'
import NativeIslands from './pages/NativeIslands'
import NativeIslandsIsr from './pages/NativeIslandsIsr'
import SuspenseData from './pages/SuspenseData'

/** Benchmark route table — one route per `scripts/benchmark.ts` PROBE.
 * Intentionally minimal: SSE/WS/blog routes are omitted (not probed). The one
 * Suspense route exists specifically to probe multi-render-per-worker
 * (renderSlots>1) — the only shape it speeds up. */
export const routes = defineRoutes([
  // React SSR — same `/` workload the bun-serve baseline renders
  // (it imports the same `_shared/HelloWorld`), so the comparison is fair.
  { path: '/', Component: HelloWorld },

  // React SSR with a per-request async-data <Suspense> (~25ms). The render
  // yields while awaiting its data, so renderSlots>1 overlaps concurrent waits
  // on one worker. Probe at BRUST_RENDER_SLOTS=1 vs N to see the interleave win.
  { path: '/suspense-data', Component: SuspenseData },

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

  // Native route + L1 response cache (declarative). Identical render to
  // /native-profile, but `cache` makes a hit serve straight from Rust's
  // ResponseCache with ZERO worker dispatch (no napi crossing). The bench hits
  // one fixed path, so after the cold first request every probe request is a
  // pure L1 hit — the delta vs /native-profile is the whole napi+worker round
  // trip the cache removes from the hot path.
  {
    path: '/native-cached/{user}',
    Component: NativeProfile,
    native: true,
    cache: { ttl_seconds: 3600 },
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
