import { defineRoutes } from '../../runtime/routes.ts'
import { counterStream } from './sse-counter.ts'

import HelloWorld    from './pages/HelloWorld'
import BlogPost      from './pages/BlogPost'
import SlowSuspense  from './pages/SlowSuspense'
import Profile       from './pages/Profile'
// A2.3 — same JSX file the brust build pipeline compiles at build time into
// $OUT_DIR/compiled_routes/static_hello.rs. Imported here only for its
// identity (Component.name = "StaticHello") which Rust uses as the registry
// key when matching the route.
import StaticHello   from '../../crates/brust/src/compiled_routes/static_hello'

/** Minimal demo — one route per major Brust feature. Failure-mode + auth +
 * cache + nested-route variants used by the integration tests live in
 * `tests/fixtures/app/` so this file stays approachable. */
export const routes = defineRoutes([
  // Routing + islands — HelloWorld embeds the <Counter /> island.
  { path: '/',             Component: HelloWorld },

  // Dynamic params + loader — the slug becomes `params.slug`; the loader's
  // return value lands as the component's `data` prop.
  { path: '/blog/{slug}',  Component: BlogPost,
    loader: async ({ params }) => ({ title: `Post: ${params.slug}` }) },

  // HTML Streaming + Suspense — the page ships a shell with a Spinner, then
  // streams the resolved content as a second chunk (~200ms).
  { path: '/slow-suspense', Component: SlowSuspense },

  // Async page + async-data child — Profile is `async function`, and its
  // <Bio /> child uses `use(promise)` inside Suspense so the bio streams
  // in as a separate chunk while the shell ships immediately.
  { path: '/profile/{user}', Component: Profile },

  // Server-Sent Events — `/sse-counter` emits 3 frames then closes; open
  // it with a browser EventSource to see them live.
  { path: '/sse-counter',   sse: (req) => counterStream(req) },

  // WebSocket — `/ws/echo` echoes every frame back unchanged. Test with any
  // WebSocket client: `wscat -c ws://127.0.0.1:3000/ws/echo` then type.
  { path: '/ws/echo',       websocket: () => import('./ws-echo.ts') },

  // A2.3 — Rust short-circuit route. Component is the same JSX the brust
  // build pipeline compiled at build time; `static: true` flips the dispatch
  // path so server.rs renders directly (no tsfn, no JS worker, no napi).
  { path: '/_rust-static',  Component: StaticHello, static: true },
])
