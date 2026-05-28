import { defineRoutes, type Middleware } from '../../../runtime/routes.ts'
import { counterStream, idleStream } from './sse-streams.ts'

// Demo components re-used by the showcase routes (kept clean in example/).
import HelloWorld    from '../../../example/hello-world/pages/HelloWorld'
import BlogPost      from '../../../example/hello-world/pages/BlogPost'
import SlowSuspense  from '../../../example/hello-world/pages/SlowSuspense'
import NativeProfile from '../../../example/hello-world/pages/NativeProfile'

// Test-only components — these mount routes that exercise failure modes,
// middleware, cache, nested routes, and the various server-action paths.
import Crash               from './components/Crash'
import CrashBoundary       from './components/CrashBoundary'
import CacheTest           from './components/CacheTest'
import Protected           from './components/Protected'
import WithHeader          from './components/WithHeader'
import NotePage            from './components/NotePage'
import AvatarPage          from './components/AvatarPage'
import WhoAmIPage          from './components/WhoAmIPage'
import AdminLayout         from './components/AdminLayout'
import AdminDashboard      from './components/AdminDashboard'
import AdminUsers          from './components/AdminUsers'
import AdminUserDetail     from './components/AdminUserDetail'
import AdminUserThrow      from './components/AdminUserThrow'
import AdminErrorBoundary  from './components/AdminErrorBoundary'

const authRequired: Middleware = async (req, next) => {
  if (!req.cookies['user']) {
    return {
      status: 401,
      body: 'unauthorised',
      headers: { 'WWW-Authenticate': 'Cookie' },
    }
  }
  return next()
}

const timeIt: Middleware = async (_req, next) => {
  const t0 = Date.now()
  const res = await next()
  res.headers = { ...(res.headers ?? {}), 'x-render-ms': String(Date.now() - t0) }
  return res
}

export const routes = defineRoutes([
  // Demo showcase routes (also reachable through example/hello-world/).
  { path: '/',             Component: HelloWorld },
  { path: '/blog/{slug}',  Component: BlogPost,
    loader: async ({ params }) => ({ title: `Post: ${params.slug}` }) },
  { path: '/slow-suspense', Component: SlowSuspense },

  // Sub-project J — `native: true` E2E coverage. NativeProfile.tsx is
  // compiled to .brust/jinja/NativeProfile.jinja at build time; this
  // route exercises the full pipeline: loader → SAB → minijinja →
  // single-chunk response.
  {
    path: '/_test/native/{user}',
    Component: NativeProfile,
    native: true,
    loader: async ({ params }) => ({
      user: params.user,
      greeting: `Hello, ${params.user}`,
    }),
  },

  // Test-only routes — failure modes + middleware + cache.
  { path: '/crash',        Component: Crash, errorBoundary: CrashBoundary },
  { path: '/cache-test',   Component: CacheTest, cache: { ttl_seconds: 60 } },
  { path: '/protected',    Component: Protected,    middleware: [authRequired] },
  { path: '/with-header',  Component: WithHeader,   middleware: [timeIt] },

  // Test-only routes — server actions (NotePage/AvatarPage/WhoAmIPage host the
  // islands that call the actions defined in tests/fixtures/app/actions.ts).
  { path: '/note',         Component: NotePage },
  { path: '/avatar',       Component: AvatarPage },
  { path: '/whoami',       Component: WhoAmIPage },

  // Test-only routes — nested admin layout with shared middleware + boundary.
  {
    path: '/admin',
    Component: AdminLayout,
    middleware: [authRequired],
    errorBoundary: AdminErrorBoundary,
    children: [
      { index: true,             Component: AdminDashboard },
      { path: 'users',           Component: AdminUsers },
      { path: 'users/throw',     Component: AdminUserThrow },
      { path: 'users/{id}',      Component: AdminUserDetail },
    ],
  },

  // SSE — counterStream is the demo, sse-gated requires auth, sse-idle uses
  // the 100ms heartbeat for the heartbeat-shape integration test.
  { path: '/sse-counter', sse: (req) => counterStream(req) },
  { path: '/sse-gated',   middleware: [authRequired], sse: (req) => counterStream(req) },
  { path: '/sse-idle',    sseOptions: { heartbeatMs: 100 }, sse: (req) => idleStream(req) },

  // WS — /ws/echo + /ws/protocols use the instrumented echo (records last
  // close into globalThis for the lastWsClose probe). /ws/gated demonstrates
  // middleware over a WS upgrade. /ws/server-close closes from the server.
  { path: '/ws/echo',          websocket: () => import('./ws-echo.ts') },
  { path: '/ws/gated',         middleware: [authRequired], websocket: () => import('./ws-echo.ts') },
  { path: '/ws/server-close',  websocket: () => import('./ws-server-close.ts') },
  { path: '/ws/protocols',     websocket: () => import('./ws-echo.ts'),
    wsOptions: { subprotocols: ['chat.v2', 'chat.v1'] } },
])
