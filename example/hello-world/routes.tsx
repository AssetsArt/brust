import { defineRoutes, type Middleware } from '../../runtime/routes.ts'
import { counterStream, idleStream } from './sse-counter.ts'
import HelloWorld    from './components/HelloWorld'
import BlogPost      from './components/BlogPost'
import Crash         from './components/Crash'
import CrashBoundary from './components/CrashBoundary'
import CacheTest     from './components/CacheTest'
import Protected     from './components/Protected'
import WithHeader    from './components/WithHeader'
import NotePage      from './components/NotePage'
import AvatarPage    from './components/AvatarPage'
import WhoAmIPage    from './components/WhoAmIPage'
import AdminLayout         from './components/AdminLayout'
import AdminDashboard      from './components/AdminDashboard'
import AdminUsers          from './components/AdminUsers'
import AdminUserDetail     from './components/AdminUserDetail'
import AdminUserThrow      from './components/AdminUserThrow'
import AdminErrorBoundary  from './components/AdminErrorBoundary'
import SlowSuspense        from './components/SlowSuspense'

// Auth middleware: 401 short-circuit if no `user` cookie.
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

// Header-mutation middleware: measure render time + tag the response.
const timeIt: Middleware = async (_req, next) => {
  const t0 = Date.now()
  const res = await next()
  res.headers = { ...(res.headers ?? {}), 'x-render-ms': String(Date.now() - t0) }
  return res
}

export const routes = defineRoutes([
  { path: '/',             Component: HelloWorld },
  { path: '/blog/{slug}',  Component: BlogPost,
    loader: async ({ params }) => ({ title: `Post: ${params.slug}` }) },
  { path: '/crash',        Component: Crash, errorBoundary: CrashBoundary },
  { path: '/cache-test',   Component: CacheTest, cache: { ttl_seconds: 60 } },
  { path: '/protected',    Component: Protected,    middleware: [authRequired] },
  { path: '/with-header',  Component: WithHeader,   middleware: [timeIt] },
  { path: '/note',         Component: NotePage },
  { path: '/avatar',       Component: AvatarPage },
  { path: '/whoami',       Component: WhoAmIPage },
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
  // SSE demo routes — counter closes after 3 frames; gated requires
  // user cookie; idle uses a 100ms heartbeat for the integration test.
  { path: '/sse-counter', sse: (req) => counterStream(req) },
  { path: '/sse-gated',   middleware: [authRequired], sse: (req) => counterStream(req) },
  { path: '/sse-idle',    sseOptions: { heartbeatMs: 100 }, sse: (req) => idleStream(req) },
  { path: '/slow-suspense', Component: SlowSuspense },
  // WS demo routes.
  { path: '/ws/echo',          websocket: () => import('./ws-echo.ts') },
  { path: '/ws/gated',         middleware: [authRequired], websocket: () => import('./ws-echo.ts') },
  { path: '/ws/server-close',  websocket: () => import('./ws-server-close.ts') },
  { path: '/ws/protocols',     websocket: () => import('./ws-echo.ts'),
    wsOptions: { subprotocols: ['chat.v2', 'chat.v1'] } },
])
