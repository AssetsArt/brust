# Public fragment-render API + shadow DOM directive scanning — design

**Date:** 2026-06-13
**Status:** draft
**Driver:** ketshopweb-engine R4 (draft canvas renders a minimal full page per section and scrapes the DOM — wants a render-component-to-HTML-string API; `renderToAwaitedString` exists but is internal) + R10 (studio canvas hosts content in Shadow DOM — the directive runtime can't see it, canvas is static-only).

## Goal

1. **R4:** `renderFragment(Component, props, opts?)` — public, renders a React component to an HTML string server-side, with the framework's request/store/loader-cache contexts properly scoped. (The native/jinja side of R4 is already served by R1's `templates.render`.)
2. **R10:** the native directive runtime scans, observes, and mounts `x-data` components inside **open** shadow roots.

## Non-goals

- R4: island hydration markers/scripts inside fragments (output is static HTML; an `<Island>` inside the fragment SSRs its component but ships no hydration — documented), streaming output, native-route fragment rendering (use `templates.render`), head/CSS collection.
- R10: closed shadow roots (unreachable by design), declarative shadow DOM SSR awareness, React-island hydration inside shadow roots (islands bootstrap is out of scope — directives only).

## R4 — `renderFragment`

New module `runtime/render/fragment.ts`:

```ts
export interface RenderFragmentOpts {
  /** Request cookies visible to cookies()/session helpers inside the tree. */
  cookies?: Record<string, string>
}
/** Render a component to an HTML string with framework contexts scoped:
 * request scope (cookies) ∘ request cache (cachedFetch/dedupe) ∘ store
 * context (fresh per call — no cross-call leakage). Suspense supported
 * (resolves when the whole tree is ready). Static HTML only — no island
 * hydration. */
export async function renderFragment<P extends object>(
  Component: React.ComponentType<P>,
  props: P,
  opts?: RenderFragmentOpts,
): Promise<string>
```

Implementation: move (or re-export) the internal `renderToAwaitedString` from `runtime/routes.ts` into the new module (routes.ts imports it back — single definition, no behavior change to the nav path). Composition VERIFIED against `runInRequestContext` (routes.ts ~55): `runInRequestScope(cookies, () => runInRequestCache(() => runInStoreContext(fn)))` — scope outermost, then cache, then store. Reuse that exact helper if exportable, else mirror it. happy-dom note for R10 verified separately; for R4 the cookie-reader test should use whatever public helper loaders use to read cookies (grep `cookies` usage in fixture loaders / runtime exports — `runInRequestScope` seeds it, routes flush set-cookies via `__scope`). Export `renderFragment` from the `brustjs` root barrel.

Error behavior: rejects with the component's error (no error-boundary semantics — caller handles).

## R10 — shadow DOM scanning

`runtime/native/runtime.ts`:

- `scanAndMount(scope)`: after the existing `[x-data]` query, walk the scope for elements with an **open** `shadowRoot`; for each: scan the root the same way (recursively — shadow roots can nest) and `observeRoot(shadowRoot)`.
- `observe()` today attaches ONE MutationObserver on `document.body`. Generalize: `observeRoot(root: Node)` attaches an observer per root, guarded by a module-level `WeakSet<Node>` (no double-observe; WeakSet keeps roots collectable). The body observer is `observeRoot(document.body)`. Shadow-root observers run the same callback (dispose removed / scan added — added nodes inside a shadow root may themselves host more shadow roots: the callback's `scanAndMount` recursion covers it).
- `disposeTree` on a removed HOST element must also dispose mounted components inside its shadow root (`node.shadowRoot` walk — the host's removal doesn't fire the shadow root's own observer).
- `bindTree` does NOT descend into shadow roots of elements inside an x-data subtree (a shadow root is its own composition boundary; its x-data components mount independently via the scan). Document.

## File structure

- `runtime/render/fragment.ts` (new) + export from runtime/index.ts barrel
- `runtime/routes.ts` — renderToAwaitedString moves out (import back)
- `runtime/render/fragment.test.ts` (new)
- `runtime/native/runtime.ts` + runtime.test.ts (shadow DOM)
- docs: rendering docs page gains a "Render fragments" section (R4, with the per-tenant/canvas use-case + templates.render cross-ref); native-interactivity gains a shadow-DOM note

## Tests

R4 (`fragment.test.ts`, real React, no server):
- simple component + props → exact HTML string
- Suspense component (async resource) → resolved HTML (not the fallback)
- store isolation **CONCURRENT**: two OVERLAPPING renderFragment calls (components that await mid-render, interleaved) using the same `defineStore` store with different seeds → each output reflects its own seed only. Sequential isolation is not sufficient evidence — AsyncLocalStorage must be shown to survive React's renderToPipeableStream scheduling (the known React/ALS escape pitfall). If the concurrent test FAILS, that is a real design problem: STOP and report BLOCKED (do not weaken to sequential).
- cookies visible via the request-scope reader (use whatever helper loaders use — find `cookies()`/`getSession` precedent in runtime)
- rejection propagates (component throws)
- nav path regression: existing navigation tests still green (renderToAwaitedString move is behavior-neutral)

R10 (`runtime.test.ts`, happy-dom — verify happy-dom supports attachShadow; if not, skipIf with a comment and rely on a small real-browser check… first VERIFY: happy-dom 20.x supports `attachShadow({mode:'open'})` — implementer probes before writing):
- x-data inside an open shadow root mounts on start()
- x-data added INTO an already-observed shadow root later mounts (observer)
- removing the shadow HOST disposes the mounted component inside its root (no detached updates)
- nested shadow root (root within root) mounts
- closed shadow root: not scanned, no throw

## Behavior invariants

1. renderFragment never touches the process-global jinja env or the worker pipeline — pure React SSR with scoped contexts.
2. Two concurrent renderFragment calls can't share store instances (ALS isolation — pinned by the isolation test).
3. Light-DOM-only apps see zero behavior change from R10 (one observer on body, same as today; the WeakSet path only activates when shadow roots exist).
4. Existing directive tests green unchanged.

## Acceptance criteria

Full `bun test` (pre-existing fail exempt) + biome green; no Rust changes; docs updated.
