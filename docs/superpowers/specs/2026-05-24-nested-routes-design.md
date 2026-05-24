# Nested Routes — Design Spec

**Sub-project:** Tier-2 follow-up. Adds parent/child route nesting + Outlet rendering.
**Date:** 2026-05-24
**Status:** approved for implementation planning
**Parent design:** `architecture.md` § "Route table"
**Related:** Server functions / Forms / `'use server'` are orthogonal — Nested Routes is purely a render-side feature.

---

## 1. Overview & Scope

### Goal

Allow routes to declare `children: Route[]` so a parent layout component can
render a shared `<Outlet />` where the matched child's content appears.
Composed paths follow React Router's relative-child shape:
`{ path: '/admin', children: [{ path: 'users' }] }` matches `/admin/users`.

The Rust route table is unchanged — flattening happens in `defineRoutes`
on the JS side, so Rust still receives a flat list of (path, cache_config)
pairs. The flat list grows: each leaf or index route in the nested tree
becomes exactly one Rust route entry.

```tsx
// example/hello-world/routes.tsx
export const routes = defineRoutes([
  // ...existing flat routes...
  {
    path: '/admin',
    Component: AdminLayout,
    middleware: [authRequired],
    errorBoundary: AdminErrorBoundary,
    children: [
      { index: true, Component: AdminDashboard },          // → /admin
      { path: 'users',          Component: AdminUsers },   // → /admin/users
      { path: 'users/{id}',     Component: AdminUserDetail }, // → /admin/users/{id}
    ],
  },
])
```

`AdminLayout` renders `<Outlet />` somewhere in its tree; the matched child
fills that slot.

### Success criterion

> Running the example app, `GET /admin` 200s with the AdminLayout shell +
> AdminDashboard content. `GET /admin/users` 200s with the AdminLayout
> shell + AdminUsers list. `GET /admin/users/42` 200s with the AdminLayout
> shell + AdminUserDetail showing id=42. `/admin*` routes without the auth
> cookie all 401 (parent middleware ran). If `AdminUserDetail` throws,
> `AdminErrorBoundary` (inherited from parent) catches.

### Concrete acceptance

```bash
$ BRUST_PORT=38900 bun run example/hello-world/index.ts &
$ sleep 6

# Index route
$ curl -s -H 'cookie: user=alice' http://127.0.0.1:38900/admin | grep -o 'AdminLayout\|AdminDashboard'
AdminLayout
AdminDashboard

# Nested path
$ curl -s -H 'cookie: user=alice' http://127.0.0.1:38900/admin/users | grep -o 'AdminLayout\|AdminUsers'
AdminLayout
AdminUsers

# Nested with param
$ curl -s -H 'cookie: user=alice' http://127.0.0.1:38900/admin/users/42 | grep -o 'AdminLayout\|UserDetail\|id=42'
AdminLayout
UserDetail
id=42

# Parent middleware applies to all children
$ curl -si http://127.0.0.1:38900/admin/users | head -1
HTTP/1.1 401 Unauthorized

# Parent errorBoundary catches child throw
$ curl -si -H 'cookie: user=alice' http://127.0.0.1:38900/admin/users/throw | head -1
HTTP/1.1 500 Internal Server Error
# body contains AdminErrorBoundary content

$ bun test
✓ 36+ integration tests pass (existing + 5 new nested-route tests)

$ cargo test --lib
✓ 55+ Rust unit tests pass (unchanged — Rust didn't touch nested routes)
```

### MVP scope decisions (locked during brainstorm 2026-05-24)

| Decision | Choice | Rationale |
|---|---|---|
| Child path style | **Relative to parent** | React Router convention. Mental model: parent path prefixes child paths automatically. |
| Index routes | **Supported** (`{ index: true, Component }`) | Standard pattern for "show this when the parent path is hit exactly". |
| Layout-only / pathless parent | **Supported** via `path: ''` | Lets users group routes under a shared layout/middleware without adding a path segment. |
| errorBoundary inheritance | **Closest ancestor wins** | Child's own `errorBoundary` takes priority; falls back to nearest parent's. React Router semantics. |
| Middleware composition | **Parent → child concatenation** | Parent middleware runs before child's. Cache lookup still happens BEFORE any middleware (existing rule). |
| Loader data | **Per-level (no merging, no sharing)** | Each Component sees ONLY its own loader's data via the `data` prop. Parent loader runs first but its data isn't auto-passed to child. |
| Cache | **Leaf-only** (no inheritance) | Cache config from the leaf route's `cache?` field. Parent's `cache` is ignored when the route is reached as part of a chain. |
| Flattening location | **JS-side, inside `defineRoutes`** | Rust receives flat list of paths + cache — zero Rust changes. |
| Loader execution order | **Sequential, parent → leaf** | Simpler than parallel; for ~3-level nesting on localhost the latency difference is sub-ms. Parallel deferred. |

### Out of scope (deferred)

1. **Parallel loader execution** — sequential is fine for MVP. Add when a real benchmark shows it matters.
2. **Loader data merging / shared parent data** — explicitly NOT supported. Each Component fetches its own data. The user can pass data via React context manually if they want sharing.
3. **Type-aware path composition checking** — TS won't enforce that `path: 'users/{id}'` results in `{ id: string }` typed Params across nested chains. Achievable with template-literal types but requires a major Route generic refactor. Today users get `Record<string, string>` Params unless they declare it manually.
4. **Nested cache inheritance** — leaf-only. If a parent layout is expensive but the child changes per request, caching has to be opt-in at the leaf.
5. **Catch-all (`*`) routes** — `matchit::Router` supports this, but the MVP doesn't expose it.
6. **Loader Suspense boundaries** — error-only boundary today; Suspense for streaming is a separate sub-project (HTML Streaming, also deferred).

---

## 2. Type changes

### 2.1 `Route<Params, Data>` augmented

In `runtime/routes.ts`:

```ts
export interface Route<Params = Record<string, string>, Data = unknown> {
  /** Relative path segment (matchit syntax). Empty string `''` = layout-only
   * (this node contributes nothing to the path; children attach to ancestors).
   * Mutually exclusive with `index: true`. */
  path?: string

  /** Index route — matches the parent path exactly. Must be a leaf (no
   * `children`, no `path`). Mutually exclusive with `path`. */
  index?: boolean

  Component: ComponentType<RouteContext<Params, Data>>
  loader?: (ctx: { params: Params; path: string; req: BrustRequest }) => Promise<Data>
  errorBoundary?: ComponentType<ErrorBoundaryProps>
  cache?: RouteCacheConfig
  middleware?: Middleware[]

  /** Nested children. Each child's path is composed with this node's path. */
  children?: Route[]
}
```

The `Params` generic stays as-is (`Record<string, string>` default). Type-aware
path composition is out of scope (§1 Out-of-scope #3).

**Params are shared across the chain.** matchit returns ALL params from the
composed pattern (`/admin/{org}/users/{id}` → `{ org, id }`). The renderer
passes the same params object to every Component in the chain, so a parent's
Component can read `params.id` defined by a descendant's path segment. This
matches React Router's behaviour.

### 2.2 New `FlatRoute` (internal)

```ts
export interface FlatRoute {
  /** Full path Rust matches against. Composed from the chain of ancestors. */
  fullPath: string
  /** Chain of Route nodes from root to leaf, inclusive. Renderer walks
   * this top-down to assemble the Outlet-nested output. */
  chain: Route[]
  /** Concatenated middleware from root → leaf. */
  middleware: Middleware[]
  /** Closest errorBoundary in the chain. Leaf's takes priority. */
  errorBoundary?: ComponentType<ErrorBoundaryProps>
  /** Cache from the leaf only — no inheritance. */
  cache?: RouteCacheConfig
}
```

`FlatRoute` is what `defineRoutes` returns and what `makeRenderer` indexes
by `route_id`.

### 2.3 `defineRoutes` signature

```ts
export function defineRoutes(routes: Route[]): FlatRoute[]
```

Previously `(Route[]) → Route[]`. The flattening transforms the type.

**Migration impact:** the example app's `routes.tsx` exports
`export const routes = defineRoutes([...])` — the inferred type becomes
`FlatRoute[]`. Existing consumers (`brust.registerRoutes(routes)`,
`makeRenderer(routes, ...)`) receive `FlatRoute[]`. Both functions need
their parameter type updated to `FlatRoute[]`. No code changes outside
the type signatures.

### 2.4 `OutletContext` + `<Outlet />`

```tsx
import { createContext, useContext, type ReactNode } from 'react'

const OutletContext = createContext<ReactNode>(null)

/** Renders the next-deeper matched route in the chain. Returns null when
 * there is no child to render (i.e., the current Component is the leaf). */
export function Outlet(): ReactNode {
  return useContext(OutletContext)
}
```

Both exported from `runtime/routes.ts`. `Outlet` is re-exported from
`runtime/index.ts` for end-user import (`import { Outlet } from 'brust'`).

---

## 3. Flattening algorithm

In `runtime/routes.ts`:

```ts
function flattenRoutes(routes: Route[]): FlatRoute[] {
  const out: FlatRoute[] = []
  walk(routes, /* chain */ [], /* basePath */ '', out)
  return out
}

function walk(
  routes: Route[],
  parentChain: Route[],
  basePath: string,
  out: FlatRoute[],
): void {
  for (const r of routes) {
    validateRoute(r, basePath)
    const chain = [...parentChain, r]

    if (r.index === true) {
      // Index route: matches the parent's basePath exactly.
      out.push(makeFlat(chain, basePath))
      continue
    }

    const ownPath = r.path ?? ''
    const myPath = joinPath(basePath, ownPath)

    if (r.children && r.children.length > 0) {
      // Non-leaf node — descend. Itself doesn't register a route unless
      // a child marks index: true (handled in the recursive call).
      walk(r.children, chain, myPath, out)
    } else {
      // Leaf with a path → emit.
      out.push(makeFlat(chain, myPath))
    }
  }
}

function joinPath(base: string, rel: string): string {
  if (rel === '') return base                      // layout-only contributes nothing
  if (rel.startsWith('/')) return rel              // absolute child overrides
  const trimmedBase = base.endsWith('/') ? base.slice(0, -1) : base
  return `${trimmedBase}/${rel}`
}

function makeFlat(chain: Route[], fullPath: string): FlatRoute {
  // Compose effective middleware: parent → child.
  const middleware: Middleware[] = []
  for (const r of chain) {
    if (r.middleware) middleware.push(...r.middleware)
  }
  // Closest errorBoundary in the chain (leaf wins).
  let errorBoundary: ComponentType<ErrorBoundaryProps> | undefined
  for (const r of chain) {
    if (r.errorBoundary) errorBoundary = r.errorBoundary
  }
  // Cache from leaf only.
  const cache = chain[chain.length - 1].cache
  return { fullPath, chain, middleware, errorBoundary, cache }
}

function validateRoute(r: Route, basePath: string): void {
  if (r.index === true && r.path !== undefined) {
    throw new Error(`route under "${basePath}": cannot set both index and path`)
  }
  if (r.index === true && r.children && r.children.length > 0) {
    throw new Error(`route under "${basePath}": index route cannot have children`)
  }
  if (!r.index && r.path === undefined && !(r.children && r.children.length > 0)) {
    throw new Error(`route under "${basePath}": must have path, index, or children`)
  }
  if (r.path !== undefined && r.path.startsWith('/') && basePath !== '') {
    // Absolute children under a non-empty parent are a footgun (the child
    // escapes the parent's URL space). Only allowed when the parent is
    // layout-only (basePath === '').
    throw new Error(
      `route under "${basePath}": absolute child path "${r.path}" must be under a pathless ('') parent`,
    )
  }
}

export function defineRoutes(routes: Route[]): FlatRoute[] {
  return flattenRoutes(routes)
}
```

### 3.1 Path-composition examples

| Parent | Child | Composed |
|---|---|---|
| `/admin` | `users` | `/admin/users` |
| `/admin` | `users/{id}` | `/admin/users/{id}` |
| `/admin/` | `users` | `/admin/users` (parent trailing slash collapsed) |
| `''` (layout-only) | `/users` | `/users` |
| `''` (layout-only) | `users` | `/users` (joinPath turns `'' + '/' + 'users'` into `/users`) |
| `/admin` | (index) | `/admin` |

Absolute child paths (children whose `path` starts with `/`) are NOT in MVP
scope. `joinPath`'s `rel.startsWith('/')` branch exists in the algorithm for
the `'' + '/users'` layout-only case, but a leading-slash child under a
non-empty parent is a footgun (looks like nesting but escapes the parent).
Validation flags this — see §3.2.

### 3.2 Validation errors

`defineRoutes` throws at module top-level (before `brust.serve`) if:
- A route has both `index: true` and `path`
- An index route has `children`
- A route is missing all of `index`, `path`, `children`
- A non-empty parent has a child whose `path` starts with `/` (absolute
  child under a non-root parent — outside MVP scope)
- Two leaf routes resolve to the same `fullPath` — caught by `matchit::Router::insert`
  returning a duplicate-pattern error, which propagates as `RouteInstallError::Insert`
  from `register_routes` (Rust) through napi to a JS throw at `brust.registerRoutes(routes)`.
  Process exits at boot.
- A composed pattern has duplicate param names (e.g. parent `/users/{id}` + child
  `posts/{id}`) — matchit returns `InsertError::Conflict`; same surfacing path as above.

---

## 4. Rendering — Outlet-based chain composition

In `runtime/routes.ts::makeRenderer`, the render branch today does:

```ts
const def = routes[route_id]
const data = def.loader ? await def.loader({ params, path, req }) : undefined
const html = renderToString(<def.Component params={params} data={data} ... />)
```

After this sub-project, the function becomes chain-aware:

```ts
const flat = routes[route_id]   // FlatRoute now
const chain = flat.chain         // Route[]

// 1. Run loaders top-down (parent → leaf). Errors caught by chain.errorBoundary.
const datas: unknown[] = []
for (const r of chain) {
  if (r.loader) {
    datas.push(await r.loader({ params, path, req }))
  } else {
    datas.push(undefined)
  }
}

// 2. Build the rendered ReactElement bottom-up.
// At the leaf, there's no Outlet content; render directly.
// At each parent, wrap with OutletContext.Provider whose value is the
// already-rendered deeper content.
let element: ReactNode = null
for (let i = chain.length - 1; i >= 0; i--) {
  const r = chain[i]
  const Component = r.Component
  const child = element
  element = (
    <OutletContext.Provider value={child}>
      <Component params={params} data={datas[i]} path={path} req={req} />
    </OutletContext.Provider>
  )
}

// 3. Wrap in errorBoundary if the chain has one.
if (flat.errorBoundary) {
  const ErrorBoundary = flat.errorBoundary
  element = <ErrorBoundary>{element}</ErrorBoundary>
}

// 4. SSR.
const html = renderToString(element)
```

### 4.1 Loader error handling

If any loader throws, the error propagates out of `await loader(...)`. The
existing `try { ... } catch (err) { renderErrorBoundary(...) }` wrapper
catches it. The closest errorBoundary in the chain (computed at flatten
time and stored on `flat.errorBoundary`) handles it. Same shape as today's
flat behaviour — just sourced from a different field.

### 4.2 Component throw inside render

If `<r.Component>` throws during `renderToString`, the errorBoundary
wrapping the tree catches it (it's a React 18+ error boundary —
React handles propagation). No special code path needed.

### 4.3 What `<Outlet />` renders when called from a leaf

Returns `null` — `OutletContext.Provider value={null}` is set at the leaf
level. Calling `<Outlet />` from a leaf Component returns nothing. Safe.

---

## 5. Middleware composition

A FlatRoute's `middleware` field is the concatenation of `r.middleware`
arrays along the chain (root → leaf). The existing `composeChain` helper
in `runtime/routes.ts` takes a `Middleware[]` and produces the chain
function — no change to that helper.

**Why root → leaf is the correct order:** `composeChain` iterates the array
right-to-left and wraps each middleware around the next inner step. So the
FIRST element in the array becomes the OUTERMOST wrap — i.e., it runs first.
Putting the parent's middleware first in `flat.middleware` therefore makes
the parent's middleware run before the child's. Verified against the
existing helper's implementation.

The renderBranch passes `flat.middleware` instead of `route.middleware`:

```ts
const chain = composeChain(req, flat.middleware, terminal)
```

The terminal step runs the Outlet-walker from §4. Existing cache lookup
still happens BEFORE middleware (`renderBranch` already reads `cache_for(route_id)`
and bypasses chain on cache hit).

---

## 6. Rust side

**Zero changes.** Rust receives a flat list of `RouteConfig { path, cache }`
from JS via `brust.registerRoutes`. Each leaf or index route in the nested
tree contributes one entry. The route_id is the array index; `matchit`
matches paths and returns route_id. Same as today.

`brust.registerRoutes` already takes `Array<{ path: string, cache?: ... }>`
in `runtime/index.ts`. With `FlatRoute[]` having both fields, the call site
shape stays identical. No napi changes.

---

## 7. Example app changes

### 7.1 Routes added

In `example/hello-world/routes.tsx`, add a new nested entry after the
existing flat routes:

```tsx
{
  path: '/admin',
  Component: AdminLayout,
  middleware: [authRequired],
  errorBoundary: AdminErrorBoundary,
  children: [
    { index: true,            Component: AdminDashboard },
    { path: 'users',          Component: AdminUsers },
    { path: 'users/{id}',     Component: AdminUserDetail },
    { path: 'users/throw',    Component: AdminUserThrow },  // demos errorBoundary inheritance
  ],
}
```

`authRequired` middleware is the existing one (reused from session 5
demos). It 401s when no `user` cookie is present.

### 7.2 Components to create

- `example/hello-world/components/AdminLayout.tsx` — wraps `<Outlet />` with a sidebar/header.
- `example/hello-world/components/AdminDashboard.tsx` — shown at `/admin`.
- `example/hello-world/components/AdminUsers.tsx` — shown at `/admin/users`.
- `example/hello-world/components/AdminUserDetail.tsx` — shown at `/admin/users/{id}`, reads `params.id`.
- `example/hello-world/components/AdminUserThrow.tsx` — throws on render, demos `AdminErrorBoundary` inheritance.
- `example/hello-world/components/AdminErrorBoundary.tsx` — minimal error boundary; renders "An admin error occurred".

Each component is 5-15 lines of JSX. No new state, no islands.

### 7.3 No changes to non-/admin/* routes

The existing 9 flat routes (path, Component) continue to work unchanged
because `defineRoutes` treats them as `chain.length === 1` — single-Component
chain with empty Outlet context.

---

## 8. Error handling

| Condition | Outcome |
|---|---|
| Two leaf routes flatten to the same path | `matchit::Router::insert` returns a duplicate error → Rust's `registerRoutes` napi returns Err → `brust.serve` propagates → process exits at boot. |
| `index: true` + `path` set | `defineRoutes` throws at module top-level → process exits before `brust.serve`. |
| index route has children | Same — throws. |
| Route missing all of index/path/children | Throws. |
| Loader throws | Caught by closest errorBoundary in the chain (or 500 if none). |
| Component throws | React error boundary in the rendered tree catches. |
| `<Outlet />` called from a leaf Component | Returns null. Safe no-op. |

---

## 9. Testing

### 9.1 Unit tests (`runtime/routes.test.ts` — NEW file)

Test `flattenRoutes` and `joinPath` directly:

1. Empty input → empty output.
2. Flat input (no children) → identity-shaped output (each entry chain length 1).
3. Two-level nesting → child fullPath composed correctly.
4. Index route → fullPath equals parent's fullPath.
5. Layout-only parent (`path: ''`) → child path is taken as-is.
6. Three-level nesting → middleware concatenated in order.
7. errorBoundary inheritance — leaf without own boundary uses parent's; leaf with its own boundary wins.
8. Leaf cache picked up; parent cache ignored when not at leaf.
9. Duplicate path detection — same fullPath in two leaves → can be detected at validate-time OR delegated to matchit. Plan delegates: matchit throws on insert; test asserts the matchit error message.
10. Validation: index + path → throws.
11. Validation: index + children → throws.
12. Validation: route with neither index, path, nor children → throws.

### 9.2 Integration tests (`tests/integration.test.ts`)

Add 5 new tests at ports 38192-38196:

1. `nested routes: index route renders parent layout + dashboard`
2. `nested routes: child path inherits parent middleware (401 without cookie)`
3. `nested routes: param child renders with merged params`
4. `nested routes: parent errorBoundary catches child throw`
5. `nested routes: flat route still renders (no regression)`

### 9.3 Rust unit tests

NONE — Rust side untouched.

---

## 10. Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| `defineRoutes` return-type change breaks existing TypeScript imports | Med | `FlatRoute` is structurally a superset of what callers need (`brust.registerRoutes` reads `.path` + `.cache`; `makeRenderer` indexes by route_id and reads `.chain`). Update the two call sites' parameter types to `FlatRoute[]`. No new type errors expected after the update. |
| Nested loader execution latency stacks (sequential) | Low | MVP scope. Real apps with 3+ levels can profile and request parallel loaders in a follow-up. |
| Cache miss on parent layout = re-render of static layout on every leaf request | Low | This is correct: parent layout depends on which child rendered. Users who want layout caching can cache at the leaf level (the full chain composes the same output). |
| `<Outlet />` used outside a nested route (e.g., in a flat route's Component) | Low | OutletContext default is `null`, so `<Outlet />` renders nothing. Documented behaviour. |
| Param collisions between parent and child (parent's `{id}` + child's `{id}` mean different things) | Low | matchit doesn't allow duplicate param names in a single pattern — composed path with two `{id}` segments will fail at `matchit::Router::insert`. Surface the error clearly. |
| Type-narrowing for `route.path` after the optional-ization | Low | TS handles `string | undefined` cleanly; the renderer doesn't directly read `route.path` — it uses the pre-composed `flat.fullPath`. |

---

## 11. Implementation order

Suggested task split for the plan phase (writing-plans will refine):

1. **Type updates + `OutletContext` + `<Outlet />`** (~20 min): augment `Route`, add `FlatRoute`, define context + component. No flattening yet.
2. **`flattenRoutes` + `joinPath` + `validateRoute` + unit tests** (~1.5 h): TDD — write the 12 unit tests, implement the algorithm.
3. **Update `defineRoutes` signature + `brust.registerRoutes` + `makeRenderer` to consume `FlatRoute[]`** (~30 min).
4. **Render walker — loader execution + bottom-up element assembly + errorBoundary wrap** (~1 h).
5. **Example app — AdminLayout + 4 child components + add nested entry to routes.tsx** (~1 h).
6. **Integration tests — 5 new tests** (~45 min).
7. **`architecture.md` — promote Nested Routes to "Built"** (~15 min).

Total estimate: ~5-6 hours via subagent-driven-development.

---

## 12. Open follow-ups (post-MVP)

- Parallel loader execution (Promise.all across chain).
- Type-aware path composition (template literal types).
- Shared parent loader data (React context helper).
- Loader Suspense boundaries (streaming SSR).
- Catch-all (`*`) routes.
- Cache inheritance / layout-level caching.
