# Nested Routes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `children: Route[]` support to the Route type, with a `<Outlet />` component for parent layouts and matching JS-side `defineRoutes` flattening so Rust receives a flat list of composed paths.

**Architecture:** JS-side flattening — `defineRoutes` walks the nested tree at boot, composes paths via `joinPath`, collects each leaf/index route into a flat `FlatRoute[]` with its full chain (root → leaf), composed middleware, closest errorBoundary, and leaf cache. Rust receives flat path + cache list unchanged. Render walker indexes `routes[route_id]` into a FlatRoute, runs each chain level's loader, then builds the rendered element bottom-up via `<OutletContext.Provider>` wrapping.

**Tech Stack:** TypeScript, React 18, Bun 1.4-canary, `bun:test`, no new Rust or TS deps. Existing `matchit` 0.8 handles composed paths.

**Spec:** `docs/superpowers/specs/2026-05-24-nested-routes-design.md`

---

## File map

| File | Action | Responsibility |
|---|---|---|
| `runtime/routes.ts` | Modify | Augment `Route<Params, Data>` (`index?`, `children?`, `path?` optional); add `FlatRoute` interface; add `OutletContext` + `<Outlet />`; add `flattenRoutes` + `joinPath` + `validateRoute`; rewrite `defineRoutes` to return `FlatRoute[]`; rewrite render branch in `makeRenderer` to walk the chain |
| `runtime/routes.test.ts` | Create | Unit tests for `flattenRoutes` + `joinPath` (12+ cases) |
| `runtime/index.ts` | Modify | Re-export `Outlet`; update `brust.registerRoutes` parameter type to `FlatRoute[]` |
| `example/hello-world/components/AdminLayout.tsx` | Create | Parent layout component using `<Outlet />` |
| `example/hello-world/components/AdminDashboard.tsx` | Create | Index route component |
| `example/hello-world/components/AdminUsers.tsx` | Create | List child |
| `example/hello-world/components/AdminUserDetail.tsx` | Create | Param child reading `params.id` |
| `example/hello-world/components/AdminUserThrow.tsx` | Create | Throws on render to exercise errorBoundary inheritance |
| `example/hello-world/components/AdminErrorBoundary.tsx` | Create | Catches admin-tree errors |
| `example/hello-world/routes.tsx` | Modify | Add nested `/admin` entry with the 4 children |
| `tests/integration.test.ts` | Modify | Add 5 new nested-route integration tests |
| `architecture.md` | Modify | Promote Nested Routes from "Designed not built" to "Built" |

---

## Task 1: Types + `OutletContext` + `<Outlet />`

**Files:**
- Modify: `runtime/routes.ts`
- Modify: `runtime/index.ts`

This task is non-breaking — adds new fields and exports without touching `defineRoutes` semantics. Existing flat routes continue to work.

- [ ] **Step 1: Augment the `Route<Params, Data>` interface**

Open `runtime/routes.ts`. Find the existing `Route<Params, Data>` interface (around line 68). Replace its body with:

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
  /** Optional async function that runs in the worker before rendering. Its
   * return value becomes the component's `data` prop. Exceptions are caught
   * by `errorBoundary` if declared (inherited from closest ancestor). */
  loader?: (ctx: { params: Params; path: string; req: BrustRequest }) => Promise<Data>
  /** Optional component invoked when Component or loader throws. Inherited
   * by descendants when they don't define their own. */
  errorBoundary?: ComponentType<ErrorBoundaryProps>
  /** Opt-in cache. Cache config from the leaf only — parent's cache is
   * ignored when the route is reached as part of a chain. */
  cache?: RouteCacheConfig
  /** Per-route middleware chain. Runs in declaration order; concatenated
   * with parent middlewares (parent runs before child). Cache lookup
   * still happens BEFORE any middleware (existing rule). */
  middleware?: Middleware[]
  /** Nested children. Each child's path is composed with this node's path
   * via `joinPath` (see flattenRoutes). */
  children?: Route[]
}
```

NOTE: `path` is now OPTIONAL (was required). `index?` and `children?` are new.

- [ ] **Step 2: Add `FlatRoute` interface**

Append below the `Route` interface (BEFORE `defineRoutes`):

```ts
/** Internal post-flatten representation. Each FlatRoute is a single leaf or
 * index route in the user's nested tree. Indexed by Rust's route_id (array
 * position). Consumed by `makeRenderer` and structurally compatible with
 * `brust.registerRoutes` (reads only `fullPath` and `cache`). */
export interface FlatRoute {
  /** Full path Rust matches against. Composed from the chain via joinPath. */
  fullPath: string
  /** Chain of Route nodes from root to leaf, inclusive. Renderer walks
   * this top-down. */
  chain: Route[]
  /** Concatenated middleware from root → leaf. composeChain wraps right-to-left,
   * so the first element here becomes the outermost wrap (runs first). */
  middleware: Middleware[]
  /** Closest errorBoundary in the chain (leaf wins; falls back up the chain). */
  errorBoundary?: ComponentType<ErrorBoundaryProps>
  /** Cache from the leaf only — no parent inheritance. */
  cache?: RouteCacheConfig
}
```

- [ ] **Step 3: Add `OutletContext` and `<Outlet />`**

At the top of `runtime/routes.ts`, find the existing `import` lines. Make sure `createContext`, `useContext`, and `type ReactNode` are imported from `react`:

```ts
import { createContext, useContext, type ComponentType, type ReactNode } from 'react'
```

(Adjust to add what's missing — don't duplicate existing imports.)

Then add (place near the type definitions, before `defineRoutes`):

```ts
/** Internal React context that carries the next-deeper rendered element to
 * the parent's <Outlet />. Default `null` means "no child to render" —
 * `<Outlet />` from a leaf route or a flat route renders nothing. */
export const OutletContext = createContext<ReactNode>(null)

/** Renders the matched child route inside a parent layout. Read via
 * React context; falls back to null at the leaf or in a flat (non-nested)
 * route. Use inside a parent Component:
 *
 *     function AdminLayout() {
 *       return <div><nav>…</nav><main><Outlet /></main></div>
 *     }
 */
export function Outlet(): ReactNode {
  return useContext(OutletContext)
}
```

- [ ] **Step 4: Re-export `Outlet` from `runtime/index.ts`**

Open `runtime/index.ts`. Find the existing re-export block (around line 97):

```ts
export { defineRoutes, makeRenderer } from './routes.ts'
```

Update to include `Outlet`:

```ts
export { defineRoutes, makeRenderer, Outlet } from './routes.ts'
```

- [ ] **Step 5: Type-check**

Run:
```bash
cd /Users/detoro/code/brust/runtime && bunx tsc --noEmit 2>&1 | grep -E "routes.ts|index.ts" | head -20
```

Expected: no NEW errors (the pre-existing `runtime/islands/_entries/react.ts` error may still appear — ignore it).

Run the existing tests:
```bash
cd /Users/detoro/code/brust/runtime && bun test 2>&1 | tail -5
```

Expected: 33 unit tests still pass — `runtime/actions.test.ts` + `runtime/scan-actions.test.ts` unaffected because they don't import `Route` / `Outlet`.

- [ ] **Step 6: Commit**

```bash
git add runtime/routes.ts runtime/index.ts
git commit -m "feat(runtime): Route gains children/index, add Outlet + FlatRoute

Foundation for nested routes:
- Route.path becomes optional (was required)
- Route gains index?: boolean and children?: Route[]
- New FlatRoute interface (internal post-flatten shape)
- OutletContext (React context, default null) + Outlet() component
  that calls useContext — returns null when no nested child to render
- Outlet re-exported from runtime/index.ts

No behavior change yet — defineRoutes still returns Route[] verbatim;
makeRenderer untouched. Subsequent tasks wire flattenRoutes + the chain
walker into the existing render path.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `flattenRoutes` + `joinPath` + `validateRoute` + unit tests

**Files:**
- Modify: `runtime/routes.ts` (add the three helpers)
- Create: `runtime/routes.test.ts`

TDD: tests first, then implementation. Helpers are pure — no IO, no React, easy to unit-test.

- [ ] **Step 1: Write the failing tests**

Create `runtime/routes.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { flattenRoutes, joinPath, type Route } from './routes.ts'

// Minimal component stub used in fixtures.
const C: any = () => null

test('joinPath: empty base + relative child', () => {
  expect(joinPath('', 'users')).toBe('/users')
})

test('joinPath: non-empty base + relative child', () => {
  expect(joinPath('/admin', 'users')).toBe('/admin/users')
})

test('joinPath: base with trailing slash collapses', () => {
  expect(joinPath('/admin/', 'users')).toBe('/admin/users')
})

test('joinPath: empty relative returns base unchanged (layout-only)', () => {
  expect(joinPath('/admin', '')).toBe('/admin')
})

test('joinPath: absolute child under empty parent (layout-only) keeps absolute', () => {
  expect(joinPath('', '/users')).toBe('/users')
})

test('flattenRoutes: empty input', () => {
  expect(flattenRoutes([])).toEqual([])
})

test('flattenRoutes: flat route stays single-entry chain', () => {
  const out = flattenRoutes([{ path: '/foo', Component: C }])
  expect(out).toHaveLength(1)
  expect(out[0].fullPath).toBe('/foo')
  expect(out[0].chain).toHaveLength(1)
  expect(out[0].chain[0].path).toBe('/foo')
  expect(out[0].middleware).toEqual([])
  expect(out[0].errorBoundary).toBeUndefined()
})

test('flattenRoutes: two-level nesting composes paths', () => {
  const out = flattenRoutes([
    {
      path: '/admin',
      Component: C,
      children: [
        { path: 'users', Component: C },
        { path: 'users/{id}', Component: C },
      ],
    },
  ])
  expect(out.map((r) => r.fullPath).sort()).toEqual(['/admin/users', '/admin/users/{id}'])
  expect(out[0].chain).toHaveLength(2)
})

test('flattenRoutes: index route matches parent path exactly', () => {
  const out = flattenRoutes([
    {
      path: '/admin',
      Component: C,
      children: [{ index: true, Component: C }],
    },
  ])
  expect(out).toHaveLength(1)
  expect(out[0].fullPath).toBe('/admin')
  expect(out[0].chain).toHaveLength(2)
})

test('flattenRoutes: layout-only parent passes children through', () => {
  const out = flattenRoutes([
    {
      path: '',
      Component: C,
      children: [{ path: '/dashboard', Component: C }],
    },
  ])
  expect(out).toHaveLength(1)
  expect(out[0].fullPath).toBe('/dashboard')
  expect(out[0].chain).toHaveLength(2)
})

test('flattenRoutes: middleware concatenated parent-first', () => {
  const mwA = async (_: any, n: any) => n()
  const mwB = async (_: any, n: any) => n()
  const mwC = async (_: any, n: any) => n()
  const out = flattenRoutes([
    {
      path: '/a',
      Component: C,
      middleware: [mwA, mwB],
      children: [{ path: 'b', Component: C, middleware: [mwC] }],
    },
  ])
  expect(out[0].middleware).toEqual([mwA, mwB, mwC])
})

test('flattenRoutes: errorBoundary leaf takes priority', () => {
  const ParentEB: any = () => null
  const ChildEB: any = () => null
  const out = flattenRoutes([
    {
      path: '/a',
      Component: C,
      errorBoundary: ParentEB,
      children: [{ path: 'b', Component: C, errorBoundary: ChildEB }],
    },
  ])
  expect(out[0].errorBoundary).toBe(ChildEB)
})

test('flattenRoutes: errorBoundary falls back to parent when leaf has none', () => {
  const ParentEB: any = () => null
  const out = flattenRoutes([
    {
      path: '/a',
      Component: C,
      errorBoundary: ParentEB,
      children: [{ path: 'b', Component: C }],
    },
  ])
  expect(out[0].errorBoundary).toBe(ParentEB)
})

test('flattenRoutes: cache from leaf only, parent ignored when chain > 1', () => {
  const out = flattenRoutes([
    {
      path: '/a',
      Component: C,
      cache: { ttl_seconds: 60 },
      children: [{ path: 'b', Component: C }],
    },
  ])
  expect(out[0].cache).toBeUndefined()
})

test('flattenRoutes: throws when index combined with path', () => {
  expect(() =>
    flattenRoutes([{ path: '/a', Component: C, children: [{ index: true, path: 'b', Component: C }] }]),
  ).toThrow(/cannot set both index and path/)
})

test('flattenRoutes: throws when index has children', () => {
  expect(() =>
    flattenRoutes([
      { path: '/a', Component: C, children: [{ index: true, Component: C, children: [{ path: 'x', Component: C }] }] },
    ]),
  ).toThrow(/index route cannot have children/)
})

test('flattenRoutes: throws when route has neither path, index, nor children', () => {
  expect(() => flattenRoutes([{ Component: C } as Route])).toThrow(/must have path, index, or children/)
})

test('flattenRoutes: throws on absolute child path under non-empty parent', () => {
  expect(() =>
    flattenRoutes([
      { path: '/a', Component: C, children: [{ path: '/escape', Component: C }] },
    ]),
  ).toThrow(/absolute child path/)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
cd /Users/detoro/code/brust/runtime && bun test routes.test.ts 2>&1 | tail -10
```

Expected: FAIL — `flattenRoutes` / `joinPath` not exported from `./routes.ts`.

- [ ] **Step 3: Implement `joinPath`**

In `runtime/routes.ts`, add this helper near the type definitions (e.g., just below the `FlatRoute` interface from Task 1):

```ts
/** Compose a child's relative path onto a parent's base path.
 *  - `rel === ''` (layout-only child) → returns `base` unchanged
 *  - `rel` starts with `/` (absolute) → returns `rel` (only valid when base === '';
 *    flattenRoutes rejects this case otherwise)
 *  - otherwise → strip any trailing `/` from base, append `/${rel}` */
export function joinPath(base: string, rel: string): string {
  if (rel === '') return base
  if (rel.startsWith('/')) return rel
  const trimmedBase = base.endsWith('/') ? base.slice(0, -1) : base
  return `${trimmedBase}/${rel}`
}
```

- [ ] **Step 4: Implement `validateRoute`**

Append below `joinPath`:

```ts
/** Validate a Route node's structural invariants in the context of its
 * parent's basePath. Throws with a useful message at module top-level —
 * route bugs fail loudly before brust.serve binds. */
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
    throw new Error(
      `route under "${basePath}": absolute child path "${r.path}" must be under a pathless ('') parent`,
    )
  }
}
```

- [ ] **Step 5: Implement `flattenRoutes`**

Append:

```ts
/** Walk the nested route tree, emitting one FlatRoute per leaf or index node.
 * Composes paths, middleware, errorBoundary, and cache per the rules in
 * the design spec (§3). */
export function flattenRoutes(routes: Route[]): FlatRoute[] {
  const out: FlatRoute[] = []
  walkRoutes(routes, [], '', out)
  return out
}

function walkRoutes(
  routes: Route[],
  parentChain: Route[],
  basePath: string,
  out: FlatRoute[],
): void {
  for (const r of routes) {
    validateRoute(r, basePath)
    const chain = [...parentChain, r]

    if (r.index === true) {
      out.push(makeFlat(chain, basePath))
      continue
    }

    const ownPath = r.path ?? ''
    const myPath = joinPath(basePath, ownPath)

    if (r.children && r.children.length > 0) {
      walkRoutes(r.children, chain, myPath, out)
    } else {
      // Leaf with a path (validated above).
      out.push(makeFlat(chain, myPath))
    }
  }
}

function makeFlat(chain: Route[], fullPath: string): FlatRoute {
  const middleware: Middleware[] = []
  for (const r of chain) {
    if (r.middleware) middleware.push(...r.middleware)
  }
  let errorBoundary: ComponentType<ErrorBoundaryProps> | undefined
  for (const r of chain) {
    if (r.errorBoundary) errorBoundary = r.errorBoundary
  }
  const cache = chain[chain.length - 1].cache
  return { fullPath, chain, middleware, errorBoundary, cache }
}
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd /Users/detoro/code/brust/runtime && bun test routes.test.ts 2>&1 | tail -10
```

Expected: `18 pass / 0 fail` (5 joinPath + 13 flattenRoutes including validation).

If a test fails, diagnose. The most likely culprits:
- joinPath edge case (empty rel, leading slash)
- middleware concat order in makeFlat
- errorBoundary assignment direction (loop must walk parent→leaf so leaf wins on overwrite)

- [ ] **Step 7: Commit**

```bash
git add runtime/routes.ts runtime/routes.test.ts
git commit -m "feat(runtime): flattenRoutes + joinPath + validateRoute

Pure JS-side helpers that walk a nested Route[] tree and emit one
FlatRoute per leaf or index node. Composes:
- fullPath via joinPath (parent prefix + child relative segment;
  layout-only parents '' contribute nothing; absolute children only
  valid under empty parents)
- middleware: parent → child concatenation (composeChain's right-to-left
  wrapping makes parent run first)
- errorBoundary: closest ancestor, leaf overrides
- cache: leaf only, no parent inheritance

validateRoute fails loudly at module top-level if:
- index combined with path or children
- route missing all of index/path/children
- absolute child path under a non-empty parent

Tests: 18 new unit tests (5 joinPath + 13 flattenRoutes including
4 validation error paths). All pass.

defineRoutes still returns Route[] verbatim — wiring happens in Task 3.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Wire `defineRoutes` → `FlatRoute[]` + rewrite render walker

**This is the LOAD-BEARING task. Atomic commit. Two-stage review (spec compliance, then code quality) per session convention.**

**Files:**
- Modify: `runtime/routes.ts` (rewrite `defineRoutes`, rewrite render branch in `makeRenderer`)
- Modify: `runtime/index.ts` (update `brust.registerRoutes` parameter type)

After this task, the 36 existing integration tests must still pass — flat routes (no children) flatten to single-entry chains and the render walker handles them identically to today.

- [ ] **Step 1: Rewrite `defineRoutes` to return `FlatRoute[]`**

Find the existing `defineRoutes` (around line 89):

```ts
export function defineRoutes(routes: Route[]): Route[] {
  return routes
}
```

Replace with:

```ts
/** Process the user's nested route tree into a flat array for the renderer
 * and Rust route table. Each leaf/index node becomes one FlatRoute. Indices
 * are stable across worker reloads (= array position), matching Rust's
 * route_id semantics. */
export function defineRoutes(routes: Route[]): FlatRoute[] {
  return flattenRoutes(routes)
}
```

- [ ] **Step 2: Update `runtime/index.ts` to accept `FlatRoute[]`**

Open `runtime/index.ts`. Find `brust.registerRoutes` (around line 53):

```ts
  registerRoutes(routes: Array<{ path: string, cache?: { ttl_seconds: number, vary?: string[] } }>): number {
```

Update its parameter type to `FlatRoute[]` AND change the property it reads from `path` to `fullPath`:

```ts
  registerRoutes(routes: import('./routes.ts').FlatRoute[]): number {
    const configs = routes.map((r) => JSON.stringify({ path: r.fullPath, cache: r.cache ?? null }))
    return (native as any).registerRoutes(configs)
  },
```

Add the import at top of the file if not already there (it's an inline `import('./routes.ts').FlatRoute[]` so no additional import line needed; or move to a top-level `import type { FlatRoute }` if you prefer — match the existing style).

- [ ] **Step 3: Find the existing render branch in `makeRenderer`**

Open `runtime/routes.ts`. Locate the render branch — the part of `makeRenderer`'s returned closure that handles `call.kind === 'render'`. It's around line 165-220 and currently looks roughly like:

```ts
async function renderBranch(call, routes, view, encoder, ...): Promise<number> {
  const def = routes[call.route_id]
  if (!def) { return notFound(...) }
  // ... composeChain(req, def.middleware, terminal) ...
  // terminal:
  //   const data = def.loader ? await def.loader({ params, path, req }) : undefined
  //   const html = renderToString(<def.Component params={params} data={data} ... />)
  //   pack response
}
```

(Exact line numbers may shift after Task 1; locate the closure body that builds the final React element.)

- [ ] **Step 4: Rewrite the render branch to walk the chain**

Replace the terminal handler (the lambda that builds the React element + calls renderToString) with a chain-walker. The general shape:

```ts
// Inside renderBranch's terminal handler:
const flat = routes[call.route_id]   // now a FlatRoute
const chain = flat.chain

// Run loaders top-down (parent → leaf). Loader throws propagate to errorBoundary below.
const datas: unknown[] = []
for (const r of chain) {
  if (r.loader) {
    datas.push(await r.loader({ params: call.params, path: call.path, req: call.req }))
  } else {
    datas.push(undefined)
  }
}

// Build the rendered element bottom-up.
// At the leaf, OutletContext.Provider value is null (nothing to render in Outlet).
// At each parent, value is the already-built deeper element.
let element: React.ReactNode = null
for (let i = chain.length - 1; i >= 0; i--) {
  const r = chain[i]
  const Component = r.Component
  const child = element
  element = (
    <OutletContext.Provider value={child}>
      <Component
        params={call.params}
        data={datas[i]}
        path={call.path}
        req={call.req}
      />
    </OutletContext.Provider>
  )
}

// Wrap in the chain's errorBoundary if present.
if (flat.errorBoundary) {
  const EB = flat.errorBoundary
  element = <EB>{element}</EB>
}

const html = renderToString(element)
```

**Important wiring notes:**

1. `composeChain(req, flat.middleware, terminal)` — pass `flat.middleware` (concatenated chain) instead of the previous `def.middleware`. composeChain is unchanged.

2. The cache lookup BEFORE middleware is in `src/server.rs` (route_id → cache_for); no JS change needed. `flat.cache` is what Rust reads via the envelope.

3. The `notFound` case (route_id missing) keeps the same shape.

4. JSX inside a `.ts` file: the existing file is `.ts` and uses `React.createElement` style (or JSX if tsconfig allows). Check the existing renderer's style — if it uses `React.createElement`, mirror it; if it uses JSX, use JSX.

   Check by reading the existing `<def.Component ... />` invocation in the file. If it's already JSX, your new code can use JSX too. If it's `React.createElement`, use that. The Step 4 pseudocode above uses JSX for readability — translate as needed.

- [ ] **Step 5: Build the napi addon (TS types are checked at runtime build)**

```bash
cd /Users/detoro/code/brust/runtime && bun run build:debug && cd -
```

Expected: clean build (one pre-existing dead_code warning).

- [ ] **Step 6: Run the unit tests**

```bash
cd /Users/detoro/code/brust/runtime && bun test 2>&1 | tail -5
```

Expected: 33 actions + scan-actions + 18 routes.test = 51 pass / 0 fail.

- [ ] **Step 7: Run the integration tests — regression guard**

```bash
bun test ./tests/integration.test.ts 2>&1 | tail -5
```

Expected: `36 pass / 0 fail`. All existing flat-route tests must still pass — flat routes flatten to single-entry chains, and the render walker handles them identically (single-iteration loop, `OutletContext.Provider value={null}`, no errorBoundary unless declared).

If a prior test fails:
- "renders X component" — likely a missing prop on the new walker (path/req/params/data shape changed). Compare the new `<Component ...>` invocation to the old one.
- "errorBoundary catches throw" — the new walker passes errorBoundary via `flat.errorBoundary`. Verify the React error boundary still receives errors thrown inside the Component subtree.
- "middleware ran" — middleware should still work; the change is from `def.middleware` to `flat.middleware` which is the SAME array for a flat route (single chain element with its own middleware).

- [ ] **Step 8: Commit**

```bash
git add runtime/routes.ts runtime/index.ts
git commit -m "feat(runtime): nested route render walker

defineRoutes now flattens nested routes into FlatRoute[] (each leaf or
index becomes one entry). The render branch of makeRenderer walks the
chain:

- Loaders run sequentially parent → leaf; each Component gets ONLY its
  own loader's data (no merge, no inheritance).
- React element built bottom-up; each level wraps the deeper level via
  <OutletContext.Provider value={renderedChild}>. <Outlet /> in any
  parent Component returns that value.
- The chain's closest errorBoundary (leaf wins) wraps the whole tree.
- composeChain receives flat.middleware (parent first → leaf last);
  its right-to-left wrap makes the parent's middleware run outermost.

brust.registerRoutes' parameter type updated to FlatRoute[]; reads
.fullPath (was .path) when serialising to Rust. Same JSON wire shape
to Rust — { path, cache? }.

Tests: 36 integration + 51 runtime unit still pass.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Example app — admin layout + 4 children

**Files:**
- Create: `example/hello-world/components/AdminLayout.tsx`
- Create: `example/hello-world/components/AdminDashboard.tsx`
- Create: `example/hello-world/components/AdminUsers.tsx`
- Create: `example/hello-world/components/AdminUserDetail.tsx`
- Create: `example/hello-world/components/AdminUserThrow.tsx`
- Create: `example/hello-world/components/AdminErrorBoundary.tsx`
- Modify: `example/hello-world/routes.tsx`

Demonstrates the feature end-to-end: parent layout, index route, child param route, parent middleware, parent errorBoundary catching a child throw.

- [ ] **Step 1: Read the existing component patterns**

Before creating new files, look at existing components for the established style:

```bash
cat /Users/detoro/code/brust/example/hello-world/components/HelloWorld.tsx
cat /Users/detoro/code/brust/example/hello-world/components/BlogPost.tsx
cat /Users/detoro/code/brust/example/hello-world/components/CrashBoundary.tsx
```

The new components should follow the same shape (default export vs named, prop type signatures, JSX style).

- [ ] **Step 2: Create `AdminLayout.tsx`**

```tsx
import { Outlet } from '../../../runtime/index.ts'

export default function AdminLayout() {
  return (
    <div data-testid="AdminLayout">
      <nav data-testid="admin-nav">
        <a href="/admin">Dashboard</a>
        <a href="/admin/users">Users</a>
      </nav>
      <main>
        <Outlet />
      </main>
    </div>
  )
}
```

- [ ] **Step 3: Create `AdminDashboard.tsx`**

```tsx
export default function AdminDashboard() {
  return (
    <section data-testid="AdminDashboard">
      <h1>Admin Dashboard</h1>
      <p>Index route — shown at /admin exactly.</p>
    </section>
  )
}
```

- [ ] **Step 4: Create `AdminUsers.tsx`**

```tsx
export default function AdminUsers() {
  return (
    <section data-testid="AdminUsers">
      <h1>Users</h1>
      <ul>
        <li><a href="/admin/users/1">User 1</a></li>
        <li><a href="/admin/users/2">User 2</a></li>
      </ul>
    </section>
  )
}
```

- [ ] **Step 5: Create `AdminUserDetail.tsx`**

```tsx
import type { RouteContext } from '../../../runtime/routes.ts'

export default function AdminUserDetail({ params }: RouteContext<{ id: string }>) {
  return (
    <section data-testid="AdminUserDetail">
      <h1>UserDetail</h1>
      <p>id={params.id}</p>
    </section>
  )
}
```

- [ ] **Step 6: Create `AdminUserThrow.tsx`**

```tsx
export default function AdminUserThrow() {
  throw new Error('intentional admin child throw — exercises parent errorBoundary')
}
```

- [ ] **Step 7: Create `AdminErrorBoundary.tsx`**

```tsx
import type { ErrorBoundaryProps } from '../../../runtime/routes.ts'

export default function AdminErrorBoundary({ error }: ErrorBoundaryProps) {
  return (
    <section data-testid="AdminErrorBoundary">
      <h1>Admin error</h1>
      <pre>{error instanceof Error ? error.message : String(error)}</pre>
    </section>
  )
}
```

(If `ErrorBoundaryProps` has different field names than `error`, check `runtime/routes.ts` and match the real shape. The existing `CrashBoundary.tsx` uses whatever Brust actually passes — match its prop usage.)

- [ ] **Step 8: Register the nested route in `routes.tsx`**

Open `example/hello-world/routes.tsx`. Add the imports near the existing component imports:

```tsx
import AdminLayout         from './components/AdminLayout'
import AdminDashboard      from './components/AdminDashboard'
import AdminUsers          from './components/AdminUsers'
import AdminUserDetail     from './components/AdminUserDetail'
import AdminUserThrow      from './components/AdminUserThrow'
import AdminErrorBoundary  from './components/AdminErrorBoundary'
```

Then append a nested entry to the `defineRoutes` array, after the existing flat routes:

```tsx
  {
    path: '/admin',
    Component: AdminLayout,
    middleware: [authRequired],
    errorBoundary: AdminErrorBoundary,
    children: [
      { index: true,             Component: AdminDashboard },
      { path: 'users',           Component: AdminUsers },
      { path: 'users/{id}',      Component: AdminUserDetail },
      { path: 'users/throw',     Component: AdminUserThrow },
    ],
  },
```

`authRequired` is the existing middleware defined at the top of `routes.tsx`. Reuse it — don't redefine.

- [ ] **Step 9: Smoke-test manually**

```bash
cd /Users/detoro/code/brust/runtime && bun run build:debug && cd -
BRUST_PORT=38920 bun run example/hello-world/index.ts > /tmp/admin-smoke.log 2>&1 &
SMOKE_PID=$!
sleep 8

# Index route (with auth cookie) — should show layout + dashboard
curl -s -H 'cookie: user=alice' http://127.0.0.1:38920/admin | grep -oE 'AdminLayout|AdminDashboard'

# Nested users route — layout + users
curl -s -H 'cookie: user=alice' http://127.0.0.1:38920/admin/users | grep -oE 'AdminLayout|AdminUsers'

# Param route — layout + detail with id
curl -s -H 'cookie: user=alice' http://127.0.0.1:38920/admin/users/42 | grep -oE 'AdminLayout|UserDetail|id=42'

# Parent middleware: 401 without cookie
curl -si http://127.0.0.1:38920/admin/users | head -1

# Parent errorBoundary catches child throw
curl -si -H 'cookie: user=alice' http://127.0.0.1:38920/admin/users/throw | head -1
curl -s  -H 'cookie: user=alice' http://127.0.0.1:38920/admin/users/throw | grep -o 'AdminErrorBoundary'

kill $SMOKE_PID 2>/dev/null
wait $SMOKE_PID 2>/dev/null
rm -f /tmp/admin-smoke.log
```

Expected:
- `/admin` → `AdminLayout` + `AdminDashboard` (both grep'd)
- `/admin/users` → `AdminLayout` + `AdminUsers`
- `/admin/users/42` → `AdminLayout` + `UserDetail` + `id=42`
- `/admin/users` without cookie → `HTTP/1.1 401 Unauthorized`
- `/admin/users/throw` → `HTTP/1.1 500 Internal Server Error` AND body grep matches `AdminErrorBoundary`

If any smoke check fails, STOP and report.

- [ ] **Step 10: Commit**

```bash
git add example/hello-world/routes.tsx example/hello-world/components/AdminLayout.tsx \
        example/hello-world/components/AdminDashboard.tsx \
        example/hello-world/components/AdminUsers.tsx \
        example/hello-world/components/AdminUserDetail.tsx \
        example/hello-world/components/AdminUserThrow.tsx \
        example/hello-world/components/AdminErrorBoundary.tsx
git commit -m "feat(example): /admin nested routes demo

Demonstrates every nested-route feature shipped:
- AdminLayout renders <Outlet/> for shared header/nav across /admin/*
- Index route at /admin → AdminDashboard
- Nested path /admin/users → AdminUsers
- Param child /admin/users/{id} → AdminUserDetail
- Parent middleware authRequired protects ALL /admin/* (401 without cookie)
- Parent errorBoundary AdminErrorBoundary catches AdminUserThrow's throw

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Integration tests — 5 new nested-route tests

**Files:**
- Modify: `tests/integration.test.ts`

- [ ] **Step 1: Confirm port availability**

```bash
cd /Users/detoro/code/brust
grep -oE "BRUST_PORT: '[0-9]+'" tests/integration.test.ts | sort -u | tail -10
```

Confirm ports 38192-38196 are NOT in use.

- [ ] **Step 2: Append the 5 tests**

Append to `tests/integration.test.ts`:

```ts
test('nested routes: index route renders parent layout + dashboard', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: { ...process.env, BRUST_PORT: '38192', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/admin`, {
      headers: { 'cookie': 'user=alice' },
    })
    expect(resp.status).toBe(200)
    const body = await resp.text()
    expect(body).toContain('AdminLayout')
    expect(body).toContain('AdminDashboard')
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)

test('nested routes: child path inherits parent middleware (401 without cookie)', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: { ...process.env, BRUST_PORT: '38193', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/admin/users`)
    expect(resp.status).toBe(401)
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)

test('nested routes: param child renders with id from path', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: { ...process.env, BRUST_PORT: '38194', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/admin/users/42`, {
      headers: { 'cookie': 'user=alice' },
    })
    expect(resp.status).toBe(200)
    const body = await resp.text()
    expect(body).toContain('AdminLayout')
    expect(body).toContain('AdminUserDetail')
    expect(body).toContain('id=42')
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)

test('nested routes: parent errorBoundary catches child throw', async () => {
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: { ...process.env, BRUST_PORT: '38195', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/admin/users/throw`, {
      headers: { 'cookie': 'user=alice' },
    })
    expect(resp.status).toBe(500)
    const body = await resp.text()
    expect(body).toContain('AdminErrorBoundary')
    expect(body).toContain('intentional admin child throw')
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)

test('nested routes: flat route still renders (no regression)', async () => {
  // Sanity test: the existing flat `/` route still works after the
  // flatten + chain-walker refactor.
  const proc = spawn({
    cmd: ['bun', 'run', 'example/hello-world/index.ts'],
    env: { ...process.env, BRUST_PORT: '38196', RUST_LOG: 'brust=warn' },
    stdout: 'pipe', stderr: 'inherit',
  })
  const port = await readPortLine(proc.stdout)
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/`)
    expect(resp.status).toBe(200)
    const body = await resp.text()
    expect(body).toContain('Hello from Brust')
  } finally {
    proc.kill('SIGINT')
    await proc.exited
  }
}, 15_000)
```

- [ ] **Step 3: Run the new tests in isolation**

```bash
cd /Users/detoro/code/brust
bun test ./tests/integration.test.ts --test-name-pattern "nested routes" 2>&1 | tail -10
```

Expected: `5 pass / 0 fail`.

If any fails:
- "index route" — check the chain order in the render walker; index routes flatten to chain[0] = parent, chain[1] = index child. The walker should render parent's Component (with `<Outlet />`) wrapping the child.
- "401 without cookie" — check that parent middleware actually concatenated into `flat.middleware`.
- "id=42" — check params propagate via `call.params` to every Component in the chain.
- "errorBoundary catches throw" — verify the `if (flat.errorBoundary) element = <EB>{element}</EB>` wrap actually happens; verify React error boundary semantics catch the throw.
- "flat route" — regression. The render walker handles `chain.length === 1` correctly.

- [ ] **Step 4: Run the full suite**

```bash
bun test ./tests/integration.test.ts 2>&1 | tail -5
```

Expected: `41 pass / 0 fail` (36 prior + 5 new).

- [ ] **Step 5: Commit**

```bash
git add tests/integration.test.ts
git commit -m "test(integration): 5 new nested-route tests

- /admin → index route under parent layout
- /admin/users without cookie → 401 (parent middleware applied)
- /admin/users/42 → param child renders with id from URL
- /admin/users/throw → parent errorBoundary catches child throw
- / → flat route still works (regression guard)

41 integration tests pass total. Ports 38192-38196.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Update `architecture.md`

**Files:**
- Modify: `architecture.md`

- [ ] **Step 1: Find the Built / Designed-not-built lists**

```bash
cd /Users/detoro/code/brust
grep -n "Nested routes\|nested routes\|Designed not built\|Built" architecture.md | head -20
```

- [ ] **Step 2: Move Nested Routes from "Designed not built" to "Built"**

Locate the bullet in "Designed not built" — it likely reads:

```
- **Nested routes** (`children: [...]`) — ~1 day.
```

(Exact wording from the live file may differ; match what's there.)

Delete it.

Add to the "Built" list (place near the `'use server'` directive and Forms entries — same Tier-2 generation):

```markdown
- **Nested routes** — `Route.children: Route[]` with React Router-style relative child paths. `<Outlet />` component renders the matched child inside a parent layout. Index routes (`{ index: true, Component }`) match the parent path exactly; layout-only parents (`path: ''`) share middleware/layout without contributing a path segment. errorBoundary inherits up the chain (leaf wins). Middleware composes parent → child. Each Component sees only its own loader's data. Rust route table unchanged — flattening happens in `defineRoutes` (JS-side) so Rust still sees a flat list.
```

(Match the bullet style of neighbouring entries — capitalisation, terminal punctuation, etc.)

- [ ] **Step 3: Verify no stale mentions**

```bash
grep -n "children:\|<Outlet />\|FlatRoute" architecture.md
```

If `defineRoutes` is described anywhere as returning `Route[]`, update the description (now returns `FlatRoute[]`). Check the file structure section if one mentions `runtime/routes.ts`.

- [ ] **Step 4: Commit**

```bash
git add architecture.md
git commit -m "docs(architecture): nested routes shipped

Moves the entry from 'Designed not built' to 'Built'. Documents the
shipped surface: Route.children, <Outlet /> component, index routes,
layout-only parents, errorBoundary chain inheritance, middleware
composition, per-level loader data. Flattening happens in JS-side
defineRoutes — Rust route table unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Spec coverage check (self-review)

Spec section → task that implements it:

| Spec § | Task |
|---|---|
| §1 Goal — `children`, `<Outlet />`, relative composition | Tasks 1, 2, 3 |
| §1 Success criterion + concrete acceptance | Tasks 4 (manual smoke), 5 (automated) |
| §2.1 Route type augmentation | Task 1 |
| §2.2 FlatRoute interface | Task 1 |
| §2.3 defineRoutes signature change | Task 3 |
| §2.4 OutletContext + `<Outlet />` | Task 1 |
| §3 flattenRoutes algorithm | Task 2 |
| §3.1 Path composition rules | Task 2 (joinPath tests) |
| §3.2 Validation errors | Task 2 (validation tests) |
| §4 Render walker | Task 3 |
| §4.1-4.3 Error handling / Outlet at leaf | Task 3 + Task 5 (errorBoundary integration test) |
| §5 Middleware composition | Task 2 (concat in makeFlat) + Task 3 (flat.middleware in composeChain) |
| §6 Zero Rust changes | Verified implicitly — no Rust files touched |
| §7 Example app changes | Task 4 |
| §8 Error handling | Task 2 (validateRoute) + Task 3 (errorBoundary wrap) |
| §9.1 flattenRoutes unit tests | Task 2 |
| §9.2 Integration tests | Task 5 |
| §9.3 No Rust tests | n/a |

All spec sections mapped. No requirements without a task.

**Type-consistency check:** `Route`, `FlatRoute`, `OutletContext`, `Outlet`, `flattenRoutes`, `joinPath`, `validateRoute`, `defineRoutes`, `RouteContext`, `Middleware`, `RouteCacheConfig`, `ErrorBoundaryProps` — all used consistently across tasks. `params`, `data`, `path`, `req` Component props match the existing `RouteContext` interface (Task 1 doesn't change RouteContext).
