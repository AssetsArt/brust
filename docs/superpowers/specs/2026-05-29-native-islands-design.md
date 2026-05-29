# Islands in the native (jinja) render path

**Status:** spec — not yet planned, not yet implemented
**Date:** 2026-05-29
**Branch:** `design/native-islands`

## Goal

Let `native: true` routes (JSX compiled to a jinja template, rendered Rust-side
via minijinja — see `2026-05-28-minijinja-dynamic-routes-design.md`) embed
interactive islands. Today islands are a React-path-only feature: the native
compiler `crates/jsx-rust-compiler/src/emit_jinja.rs` rejects interactivity
(`lib.rs:51` — event handlers are "handled by islands in Phase A3"), and the
client bootstrap only knows how to `hydrateRoot` markup React produced. This
spec is Phase A3: a `native` page is a fast static shell (jinja, ~60k RPS
worker-crossing floor — `[[napi-crossing-floor]]`) with interactive islands
hydrated client-side, in the canonical islands-architecture (Astro-style) shape.

Two modes of the same feature:

1. **Client-only island (default).** The compiler emits an empty island mount
   marker; the client renders the component into it after load. No server
   render of the island. Cheapest; correct for below-fold / interaction-gated
   widgets. Trade-off: empty until JS runs (layout shift / no content without
   JS).
2. **Server island (opt-in, `ssr`).** The worker `renderToString`s ONLY that
   island's component (not the page) during the loader visit it already makes,
   and the markup is injected into the jinja shell at the mount point. Result:
   SSR'd markup (no layout shift, SEO-visible) + client hydration, at roughly
   native speed minus the (small) per-island render cost — because only the
   islands are React-rendered, not the whole tree.

## Non-goals

- **Faster than the ~60k worker-crossing floor for SSR islands.** Server islands
  run in the worker (the loader crossing); they inherit that floor. This spec
  does not try to beat it. A loader-less, island-less native route still renders
  Rust-only and is out of scope here.
- **Arbitrary prop expressions.** v1 island props are a single path into the
  loader's return value (see "Island prop contract"), not arbitrary JS
  expressions evaluated at render. Object-literal props (`props={{a: data.x}}`)
  are deferred.
- **Streaming / Suspense inside a native island.** Islands SSR via
  `renderToString` (synchronous), not `renderToPipeableStream`. Suspense-using
  island components are rejected at build time (or render their fallback).
- **Nested islands inside a native route's children.** Native routes already
  forbid nested route children; islands nest only within the single leaf JSX.
- **Changing the React-path island behavior.** The React render path
  (`runtime/routes.ts` render branch → `renderBranchStreaming`) is untouched.

## Background: how islands work today (React path)

- `runtime/islands/island.tsx` — `<Island id component props hydrate>` renders
  `<div data-brust-island=ID data-brust-props=JSON data-brust-hydrate=TRIGGER>{SSR'd component}</div>`
  and flips a module `__used` flag.
- `runtime/render/stream.ts:130` — reads `consumeIslandUsedFlag()`; when set,
  prepends `ISLANDS_IMPORTMAP_AND_BOOTSTRAP` (`runtime/islands/importmap.ts`:
  an importmap `<script>` + `<script type="module" src="/_brust/islands/_bootstrap.js" defer>`).
- `runtime/islands/bootstrap.ts` — on `DOMContentLoaded`, `hydrateMarkersIn`
  scans `[data-brust-island]:not([data-brust-hydrated])`, registers the hydrate
  trigger, and `hydrateOne` does `hydrateRoot(el, createElement(Component, props))`
  after dynamic-importing `/_brust/islands/<id>.js`.
- `runtime/islands/build.ts` — `buildIslands` bundles each island's client chunk
  + `_bootstrap.js`.

The two load-bearing facts for this spec:
- **`hydrateRoot` requires the mount's existing markup to match** the client
  tree. An empty mount + `hydrateRoot` is a hydration mismatch in React 19
  (recovers by client-rendering, but logs an error). → client-only needs a
  different client entry.
- **Native routes already cross into the worker** to run the leaf `loader`
  (`runtime/routes.ts` native branch → `napiRenderJinja`). Server-island SSR
  adds CPU to that existing visit; it does NOT add a new napi crossing.

## High-level architecture

### Compiler (`crates/jsx-rust-compiler`)

`<Island ... />` in a native route's JSX is recognized by the lowering/emit
stage (today unknown components are rejected). For each island the compiler:

1. Emits the mount marker into the jinja template:
   ```jinja
   <div data-brust-island="<id>"
        data-brust-props="{{ <propsPath> | tojson }}"
        data-brust-hydrate="<trigger>">{{ island_<id>_html | safe }}</div>
   ```
   - `data-brust-props` is filled from the jinja template context via minijinja's
     `tojson` filter (NOTE: confirm `tojson` is available in the brust minijinja
     build; if not, the loader pre-serializes and the attr reads a string path).
   - `island_<id>_html` is a context variable holding the server-rendered markup
     for `ssr` islands; for client-only islands the compiler omits the slot
     (empty mount).
2. Bakes `ISLANDS_IMPORTMAP_AND_BOOTSTRAP` into the template (once, near the end
   of `<body>` or `<head>`) when the component uses ≥1 island — so script
   injection is a build-time constant with zero runtime cost. (The exact markup
   string is shared with the React path via a single source of truth — see Open
   questions.)
3. Emits a per-route **island manifest** consumed at build + runtime:
   `[{ id, importPath, propsPath, ssr: bool, hydrate }]`. Lives next to the
   emitted `.jinja` (e.g. `.brust/jinja/<Name>.islands.json`).

### Build pipeline (`runtime/cli/native-routes-emit.ts` + `runtime/islands/build.ts`)

- The native-template emit step scans each native route's JSX for `<Island>` and
  produces the island manifest above.
- `buildIslands` is extended (or its caller) to include native routes' islands
  in the set of client chunks bundled to `/_brust/islands/<id>.js` — today the
  scan only sees React-tree islands.

### Runtime — native branch (`runtime/routes.ts`)

The native branch currently: run loader → write loader JSON to SAB →
`napiRenderJinja(workerId, dataLen, template)` (sync, returns framed length —
the fast lane). Extended:

1. Load the route's island manifest (built above).
2. For each `ssr` island: resolve `props = pathInto(data, propsPath)`, dynamic-
   import the component, `renderToString(createElement(Component, props))` →
   markup string.
3. Build the jinja context = `{ ...loaderData, island_<id>_html: markup }` for
   each SSR island. Client-only islands contribute no `_html` key.
4. Serialize that context into the SAB and call `napiRenderJinja` as today.
   napiRenderJinja renders the template (which now has the island markers +
   baked bootstrap) and returns the framed length (unchanged fast-lane contract).

Client-only islands add **zero** worker-side work beyond what the compiler baked
into the template. Server islands add one synchronous `renderToString` per SSR
island, inside the existing crossing.

### Runtime — client bootstrap (`runtime/islands/bootstrap.ts`)

`hydrateOne` auto-detects the mode by whether the mount has server markup:

```ts
const isEmpty = el.childNodes.length === 0   // or a data-brust-csr marker
if (isEmpty) {
  createRoot(el).render(createElement(Component, props))   // client-only
} else {
  hydrateRoot(el, createElement(Component, props))         // server island
}
```

This single change makes the existing bootstrap serve both modes. The
navigation interceptor's `unmountIslandsIn` must unmount `createRoot` roots too
(track them in the same `islandRoots` WeakMap — `createRoot` returns a `Root`
with `.unmount()`, same as `hydrateRoot`).

## Island prop contract (v1)

`props` must be a single path into the loader's return value:
`<Island component={Counter} props={data.counter} ssr />` → manifest
`propsPath: "counter"`. The same value feeds both `renderToString` (server
island) and `data-brust-props` (`{{ counter | tojson }}`). This keeps the prop
resolvable in both Rust/jinja and JS without an expression evaluator. Object
literals and computed expressions are a Non-goal for v1.

## File structure

- `crates/jsx-rust-compiler/src/lower.rs` + `emit_jinja.rs` — recognize
  `<Island>`, emit marker + optional SSR slot + baked bootstrap; emit manifest.
- `crates/jsx-rust-compiler/src/lib.rs` — relax the event-handler rejection only
  inside island subtrees (island children are client components; their handlers
  are legal and never compiled to jinja).
- `runtime/cli/native-routes-emit.ts` — write `<Name>.islands.json` manifest.
- `runtime/islands/build.ts` (or caller) — include native islands in the bundle.
- `runtime/routes.ts` — native branch: load manifest, SSR `ssr` islands, merge
  into jinja context.
- `runtime/islands/bootstrap.ts` — `createRoot` vs `hydrateRoot` auto-detect;
  unmount parity.
- `runtime/islands/importmap.ts` — single source of truth for the bootstrap
  markup the compiler bakes in.

## Behavior / invariants

- **Fast-lane contract unchanged.** napiRenderJinja still returns the framed
  `[meta_len][meta][body]` length; the native route still dispatches through
  `dispatch_single_chunk`. Islands change only the template + context, not the
  response protocol.
- **Hydration correctness.** For `ssr` islands, the markup `renderToString`
  produces inside the mount MUST equal what the client chunk renders from the
  same props (same component, same props) — the standard React hydration
  contract. The shared `propsPath` value guarantees identical props on both
  sides.
- **No island ⇒ no bootstrap.** A native route with no `<Island>` emits no
  importmap/bootstrap script and behaves exactly as today.
- **SSR-island failure is contained.** If a server-island `renderToString`
  throws, fall back to client-only for that island (emit empty mount + props)
  rather than 500-ing the page; log it. (The loader-throw path already 500s the
  whole page; island-render-throw should degrade, not fail the shell.)

## Tests

- **Compiler (Rust, golden):** a fixture JSX with `<Island>` (client-only and
  `ssr`) emits the expected jinja marker, the `| tojson` props attr, the
  `{{ island_X_html | safe }}` slot (ssr) / no slot (client-only), and the baked
  bootstrap exactly once.
- **Compiler:** event handlers INSIDE an island subtree are allowed; outside
  (in the static shell) still rejected.
- **Runtime (bun unit):** bootstrap `hydrateOne` uses `createRoot` for an empty
  mount and `hydrateRoot` for a populated one; `unmountIslandsIn` unmounts both.
- **Runtime (bun unit):** native branch resolves `propsPath` into loader data,
  `renderToString`s the `ssr` island, and merges `island_<id>_html` into the
  context; client-only island contributes no `_html` key.
- **Integration (`tests/`):** a native route with (a) a client-only island —
  response has empty marker + props + bootstrap, no SSR markup; (b) an `ssr`
  island — response has SSR markup inside the marker; a real browser/Playwright
  smoke confirms hydration (button click increments) for both.
- **Regression:** existing `tests/jinja-route.test.ts` (native, no islands) and
  the React-path island tests stay green.

## Acceptance criteria

1. `cargo test --workspace --lib` green incl. new golden island fixtures.
2. `bun test runtime/` + `bun test tests/` green; no regression in existing
   native or React-path island tests.
3. A native route with a client-only island: server response contains the empty
   marker + `data-brust-props` + the bootstrap script; the island becomes
   interactive after load (browser smoke).
4. A native route with an `ssr` island: server response contains SSR markup
   inside the marker; `hydrateRoot` produces no hydration-mismatch warning; the
   island is interactive (browser smoke).
5. A native route with no island is byte-identical to today (no bootstrap).
6. `bun run bench` `/native-profile/World` (no islands) unchanged at the ~60k
   floor; a new native-with-island probe documents its cost.

## Known limitations (v1)

- Props limited to a single path into loader data (see contract).
- Server-island SSR is synchronous (`renderToString`); no Suspense in islands.
- Client-only islands flash empty until hydration; not for above-fold/SEO
  content — use `ssr` there.
- Server islands inherit the ~60k worker-crossing floor (they run in the loader
  visit); heavy island render lowers it proportionally.
- Per-island SSR error degrades to client-only for that island (logged), not a
  page 500.

## Open questions (resolve at plan-time)

1. **minijinja `tojson` filter availability** in the brust build. If absent:
   add it (minijinja supports custom filters), or have the loader pre-serialize
   props and the attr read a string. Confirm before planning the compiler emit.
2. **Bootstrap markup single-source-of-truth across Rust and JS.** The compiler
   (Rust) must bake the exact same importmap/bootstrap string the JS path uses
   (`runtime/islands/importmap.ts`). Options: codegen the string into the
   compiler, or have the build step (TS) post-process the emitted template to
   inject it. Latter keeps one source of truth in TS — likely preferred.
3. **Empty-mount detection** in `hydrateOne`: `childNodes.length === 0` vs an
   explicit `data-brust-csr` attribute emitted by the compiler. Explicit
   attribute is more robust (whitespace text nodes can make a "client-only"
   mount non-empty). Lean explicit.
4. **Island discovery for the build** when the only island usage is inside
   native JSX the React tree never renders — the scan must read the compiler's
   emitted manifest, not a runtime `__used` flag.
5. **`hydrate` triggers** (`idle`/`visible`/`interaction`) for client-only
   islands — `createRoot` path must honor them identically to the hydrate path
   (the trigger registration in `hydrateMarkersIn` already wraps both).
