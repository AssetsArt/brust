import { existsSync } from 'node:fs'
import path from 'node:path'
import {
  defineRoutes,
  mdRoutes,
  notFound,
  redirect,
  type Middleware,
} from '../../../runtime/routes.ts'
import { counterStream, idleStream } from './sse-streams.ts'
import { cache } from '../../../runtime/cache.ts'

// Fixture-local page copies. The test fixture is SELF-CONTAINED — it must not
// import from any example/ app, so deleting or regenerating an example never
// breaks the test suite.
import HelloWorld    from './pages/HelloWorld'
import BlogPost      from './pages/BlogPost'
import SlowSuspense  from './pages/SlowSuspense'
import SlowFresh     from './pages/SlowFresh'
import StoreDemo     from './pages/StoreDemo'
import { counter }   from './stores/counter'
import NativeProfile from './pages/NativeProfile'
import NativeNestedMap from './pages/NativeNestedMap'
import NativeDataAttr  from './pages/NativeDataAttr'
import NativeOutletLayout from './pages/NativeOutletLayout'
import NativeOutletLeaf   from './pages/NativeOutletLeaf'
import MdDocsLayout from './pages/MdDocsLayout'
import NativeIslandPage from './NativeIslandPage'
import NativeSsrIslandPage from './NativeSsrIslandPage'
import NativeTwoIslandPage from './NativeTwoIslandPage'
import NativeSsrComp from './NativeSsrComp'
import NativeInline from './NativeInline'

// Test-only components — these mount routes that exercise failure modes,
// middleware, cache, nested routes, and the various server-action paths.
import Crash               from './components/Crash'
import CrashBoundary       from './components/CrashBoundary'
import CacheTest           from './components/CacheTest'
import CachePrefixTest     from './components/CachePrefixTest'
import CacheTaggedTest     from './components/CacheTaggedTest'
import CacheParamTest      from './components/CacheParamTest'
import CacheBypassTest     from './components/CacheBypassTest'
import Protected           from './components/Protected'
import WithHeader          from './components/WithHeader'
import NotePage            from './components/NotePage'
import WhoAmIPage          from './components/WhoAmIPage'
import AdminLayout         from './components/AdminLayout'
import AdminDashboard      from './components/AdminDashboard'
import AdminUsers          from './components/AdminUsers'
import AdminUserDetail     from './components/AdminUserDetail'
import AdminUserThrow      from './components/AdminUserThrow'
import AdminErrorBoundary  from './components/AdminErrorBoundary'

// md component registry (task 2.10): the THREE-identity rule — the md tag name,
// the mdRoutes `components` key, and these default-import idents must all match.
// Counter is an island (React); BehaviorBadge is a native behavior component.
import Counter             from './components/Counter'
import BehaviorBadge       from './components/BehaviorBadge'

// Markdown pages (task 2.10). The content dir is passed RELATIVE — the supported
// pattern for prebuilt dists (the frozen md-manifest records the same relative
// string, so manifest matching is cwd-stable between build and boot; an
// import.meta-anchored absolute path would not survive bundling). Because this
// shared fixture is also built/booted from OTHER cwds (repo root, isolated tmp
// projects — e.g. tests/cli-build.test.ts, tests/ssg.test.ts), the md routes are
// GATED: active when the content dir exists at cwd (source mode / builds run
// from this dir) or when a prebuilt dist ships a frozen md-manifest.json.
// Everywhere else the fixture stays a no-md app, preserving the byte-identical
// no-md build invariant those tests assert.
const MD_CONTENT_DIR = 'content/docs'
const mdActive =
  existsSync(MD_CONTENT_DIR) ||
  (process.env.BRUST_PREBUILT === '1' &&
    process.env.BRUST_DIST_DIR !== undefined &&
    existsSync(path.join(process.env.BRUST_DIST_DIR, 'md-manifest.json')))

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
  // Markdown pages (task 2.10) — /docs, /docs/intro, /docs/query/where under a
  // native layout (chained mode: MdDocsLayout owns BrustPage + <main><Outlet/>).
  ...(mdActive
    ? mdRoutes(MD_CONTENT_DIR, {
        prefix: '/docs',
        layout: MdDocsLayout,
        components: { Counter, BehaviorBadge },
      })
    : []),

  // Demo showcase routes.
  { path: '/',             Component: HelloWorld },
  { path: '/blog/{slug}',  Component: BlogPost,
    loader: async ({ params }) => ({ title: `Post: ${params.slug}` }) },
  { path: '/slow-suspense', Component: SlowSuspense },
  { path: '/slow-fresh', Component: SlowFresh },

  // Spec A / isomorphic store (T8) — React-path route whose loader seeds the
  // per-request `counter` store from a `?seed=N` query param. The render
  // pipeline collects the store snapshot after the loader runs and injects it as
  // a <script data-brust-store="counter"> before </head>. Each request gets an
  // isolated store instance (S6 — no cross-request leak).
  {
    path: '/store-demo',
    Component: StoreDemo,
    loader: async ({ req }) => {
      const seed = Number(req.search['seed'] ?? '0')
      counter.value.set(Number.isFinite(seed) ? seed : 0)
      return {}
    },
  },

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
  // S9 — native loader status sentinels. Reuse NativeProfile's compiled template.
  {
    path: '/_test/native-notfound/{user}',
    Component: NativeProfile,
    native: true,
    loader: async ({ params }: { params: { user: string } }) =>
      notFound({ user: params.user, greeting: `Hello, ${params.user}` }),
  },
  {
    path: '/_test/native-redirect',
    Component: NativeProfile,
    native: true,
    loader: async () => redirect('/_test/native/landed'),
  },
  // Nested `.map()` native-render coverage (verify gap).
  {
    path: '/_test/nested-map',
    Component: NativeNestedMap,
    native: true,
    loader: async () => ({
      rows: [
        { id: 'r0', cells: [{ label: 'a' }, { label: 'b' }] },
        { id: 'r1', cells: [{ label: 'c' }] },
      ],
    }),
  },
  // BrustPage data-* on <html> coverage.
  {
    path: '/_test/data-attr',
    Component: NativeDataAttr,
    native: true,
    loader: async () => ({ mode: 'r42' }),
  },
  // B7 — native store-snapshot SSR. Reuses NativeDataAttr (a BrustPage document);
  // loader seeds the per-request `counter` store from ?seed=N (mirrors /store-demo).
  {
    path: '/_test/native-store',
    Component: NativeDataAttr,
    native: true,
    loader: async ({ req }) => {
      const seed = Number(req.search['seed'] ?? '0')
      counter.value.set(Number.isFinite(seed) ? seed : 0)
      return { mode: 'store' }
    },
  },
  // T4 — native <Outlet> nested-route E2E. A native PARENT layout
  // (NativeOutletLayout, BrustPage shell + <nav> + <main><Outlet/></main>)
  // wrapping a native LEAF fragment (NativeOutletLeaf). The build composes the
  // whole chain into ONE native template (synth wrapper → <Outlet/> filled with
  // the leaf body). Each node has its OWN loader; runNativeChainLoaders merges
  // them top-down (child-wins) so the composed template sees BOTH the parent's
  // `section`/`title` AND the leaf's `widget`. Proves T1+T2+T3 together.
  {
    path: '/_test/outlet',
    Component: NativeOutletLayout,
    native: true,
    loader: async () => ({ title: 'Outlet Page', section: 'parent-zone' }),
    children: [
      {
        index: true,
        Component: NativeOutletLeaf,
        native: true,
        loader: async () => ({ widget: 'leaf-thing' }),
      },
    ],
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

  // Sub-project J / native inline — native: true route with inlined pure
  // components (InlineBadge), hook-fallback SSR components (HookBadge), and an
  // inlined pure wrapper that itself embeds an Island (WrapCounter → Counter).
  // Proves the full inline + fallback + Island-reconcile pipeline end-to-end.
  {
    path: '/_test/native-inline',
    Component: NativeInline,
    native: true,
    loader: async () => ({ label: 'Hi', strong: true, count: { start: 0, label: 'c' } }),
  },

  // Test-only routes — failure modes + middleware + cache.
  {
    path: '/crash',
    Component: Crash,
    errorBoundary: CrashBoundary,
  },
  {
    path: '/crash-boundary',
    Component: CrashBoundary,
  },
  { path: '/cache-test',   Component: CacheTest, cache: { ttl_seconds: 60 } },
  { path: '/cache-prefix', Component: CachePrefixTest, cache: { ttl_seconds: 60, prefix: 'cookie(seg)' } },
  { path: '/cache-param/{id}', Component: CacheParamTest, cache: { ttl_seconds: 60, prefix: 'param(id)' } },
  { path: '/cache-bypass', Component: CacheBypassTest, cache: { ttl_seconds: 60, bypass: 'cookie(fresh)' } },
  // L1 static tag invalidation: this route's L1 entries carry `grp-a`.
  { path: '/cache-tagged', Component: CacheTaggedTest, cache: { ttl_seconds: 60, tags: ['grp-a'] } },
  // Uncached sibling whose loader invalidates the `grp-a` L1 tag group (runs in
  // the worker, where the napi binding lives). Hitting it evicts /cache-tagged.
  {
    path: '/cache-invalidate-tagged',
    Component: CacheTaggedTest,
    loader: async () => {
      cache.invalidate({ tags: ['grp-a'] })
      return {}
    },
  },
  { path: '/protected',    Component: Protected,    middleware: [authRequired] },
  { path: '/with-header',  Component: WithHeader,   middleware: [timeIt] },

  // Test-only routes — server actions (NotePage/WhoAmIPage host the
  // islands that call the actions defined in tests/fixtures/app/actions.ts).
  { path: '/note',         Component: NotePage },
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
