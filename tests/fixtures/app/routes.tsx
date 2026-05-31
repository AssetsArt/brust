import { defineRoutes, type Middleware } from '../../../runtime/routes.ts'
import { counterStream, idleStream } from './sse-streams.ts'

// Demo components re-used by the showcase routes (kept clean in example/).
import HelloWorld    from '../../../example/hello-world/pages/HelloWorld'
import BlogPost      from '../../../example/hello-world/pages/BlogPost'
import SlowSuspense  from '../../../example/hello-world/pages/SlowSuspense'
import NativeProfile from '../../../example/hello-world/pages/NativeProfile'
import NativeIslandPage from './NativeIslandPage'
import NativeSsrIslandPage from './NativeSsrIslandPage'
import NativeTwoIslandPage from './NativeTwoIslandPage'
import NativeSsrComp from './NativeSsrComp'

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
  // Sub-project J / native islands — native: true route hosting a CLIENT-ONLY
  // <Island> (no ssr). The compiled .jinja emits an empty data-brust-csr mount
  // div + a baked {% raw %} importmap/bootstrap block; T7's native branch fills
  // island_Counter_props with the entity-encoded JSON of the resolved props.
  {
    path: '/_test/native-island',
    Component: NativeIslandPage,
    native: true,
    loader: async () => ({ greeting: 'Hello islands', count: { start: 3 } }),
  },
  // Sub-project J / native SSR islands — native: true route hosting an SSR
  // <Island ... ssr>. The compiled .jinja emits a mount with NO data-brust-csr
  // and an `{{ island_Counter_html | safe }}` placeholder INSIDE the mount div;
  // T9's native branch imports Counter's source .tsx and renderToStrings it
  // server-side, filling the placeholder with the initial markup.
  {
    path: '/_test/native-island-ssr',
    Component: NativeSsrIslandPage,
    native: true,
    loader: async () => ({ greeting: 'SSR islands', count: { start: 5 } }),
  },
  // Sub-project J / component-addressed islands — native: true route hosting
  // TWO <Island component={Counter}> reusing the SAME Counter: instance 0 is
  // client-only (empty data-brust-csr mount), instance 1 is ssr (server-rendered
  // <button> inside the mount). The two instances carry distinct props paths
  // (`first`/`second`) → distinct data-brust-props; both share ONE Counter.js
  // chunk. Proves the two-instance reuse + chunk-dedup acceptance case.
  {
    path: '/_test/native-two-islands',
    Component: NativeTwoIslandPage,
    native: true,
    loader: async () => ({
      greeting: 'Two islands',
      first: { start: 1 },
      second: { start: 2 },
    }),
  },
  // Sub-project J / SSR components — native: true route hosting a plain React
  // component (NativeLayout, defined inline) rendered server-side via
  // resolveComponentContext. Proves the component manifest + factory pipeline
  // wired in routes.ts dispatch.
  {
    path: '/native-ssr-comp',
    Component: NativeSsrComp,
    native: true,
    loader: async () => ({
      greeting: 'SSR component test',
      counter: { start: 0, label: 'clicks' },
    }),
  },

  // Test-only routes — failure modes + middleware + cache.
  {
    path: '/crash',
    Component: Crash,
    errorBoundary: CrashBoundary,
    loader: async () => ({ crash: false }),
  },
  {
    path: '/crash-boundary',
    Component: CrashBoundary,
    loader: async () => ({ crash: true }),
  },
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
      { path: 'users/throw',     Component: AdminUserThrow, loader: async () => ({ crash: true }), },
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
