# Islands in the native (jinja) render path

**Status:** spec — reviewed (fix-then-plan); gating questions resolved (2026-05-29); ready to plan
**Date:** 2026-05-29
**Branch:** `design/native-islands`

> **Spec-review applied (2026-05-29).** A reviewer subagent verified claims
> against the code. Material outcomes folded in below: `tojson` is absent and
> the props attribute needs attribute-safe serialization (see "Island prop
> serialization"); the compiler change is a dedicated `<Island>` node, not a
> relaxed rejection (see "Compiler"); server-island props must render from the
> JSON-roundtripped value (see invariants); server-island component module
> resolution and CSS-on-native-island are unresolved and gate `ssr` mode (see
> Open questions). `createRoot` is confirmed importable and the importmap needs
> no per-island entries.

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

`<Island ... />` in a native route's JSX needs a **dedicated recognition path**
— this is materially more than "relax the event-handler rejection." Review
found `<Island>` is rejected at `lower_element_name` (`lower.rs:300-307`,
`CustomComponentNotSupported`) BEFORE any attribute is examined, the `component`
/`props` props reference out-of-scope idents (`lower.rs:651`
`UnresolvedIdent`), and the IR (`ir.rs`) has no component-node variant. So the
compiler work is: (a) a special-case in `lower_element` that matches the
`Island` identifier, (b) a new IR node carrying `{id, propsPath, hydrate, ssr}`,
(c) prop-path extraction that bypasses normal expr lowering, (d) emit support in
`emit_jinja.rs` (which today only emits host elements, `emit_jinja.rs:42-63`).
Event handlers INSIDE the island's component subtree are never compiled to jinja
(the component lives in a client chunk), so they're simply not the compiler's
concern — only the `<Island>` call site is.

For each island the compiler:

1. Emits the mount marker into the jinja template:
   ```jinja
   <div data-brust-island="<id>"
        data-brust-props="{{ island_<id>_props }}"
        data-brust-hydrate="<trigger>"
        {client-only: data-brust-csr}>{{ island_<id>_html | safe }}</div>
   ```
   - **`data-brust-props` reads a PRE-SERIALIZED, attribute-safe string from the
     context, NOT `| tojson`.** Review confirmed: the brust minijinja build
     (`minijinja 2.20`, default features only — `crates/brust/Cargo.toml:28`)
     does NOT include the `json` feature, so `tojson` is unavailable; and the
     env sets no autoescape (`jinja.rs:29`, extensionless template stems), so
     even raw JSON would break the quoted attribute (`"` closes it). The native
     branch (JS) serializes the island props to an attribute-safe string
     (`JSON.stringify` then HTML-entity-encode `"`/`&`/`<`/`>`, matching what
     React does at `island.tsx:49-56`) and passes it as `island_<id>_props` in
     the context. `safe` IS available (default `builtins`) so the `_html` slot
     is fine.
   - `data-brust-csr` (client-only marker) is emitted for client-only islands so
     the bootstrap can pick `createRoot` deterministically rather than sniffing
     `childNodes.length` (whitespace text nodes make emptiness unreliable).
   - `island_<id>_html` holds the server-rendered markup for `ssr` islands; for
     client-only islands the compiler omits the slot (empty mount).
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
- **Registry reconciliation (review Fix 4).** There is no runtime island
  "scan" — `buildIslands` bundles from a static, user-authored
  `island.config.ts` (`cfg.islands: Record<id, entryPath>` — `build.ts:14,32,54`);
  the `__used` flag (`island.tsx:26`) only gates *bootstrap injection*, not
  discovery. So native islands introduce a SECOND registry (the per-route
  `.islands.json`). The build must (a) bundle a client chunk for every native
  island id, and (b) enforce id-uniqueness ACROSS `island.config.ts` and all
  native manifests (a collision means two components fighting over
  `/_brust/islands/<id>.js`). **RESOLVED (gating Q3): one registry.** Native
  islands MUST be registered in `island.config.ts` (author lists them, same as
  React-path islands). The per-route `.islands.json` carries only
  `{id, propsPath, ssr, hydrate}`; the build VALIDATES every native-island id
  exists as a key in `island.config.ts` (clear error otherwise) and reuses the
  config's `sourcePath` for both the client bundle and the worker-side SSR
  import. No second registry, no merge step.

### Runtime — native branch (`runtime/routes.ts`)

The native branch currently: run loader → write loader JSON to SAB →
`napiRenderJinja(workerId, dataLen, template)` (sync, returns framed length —
the fast lane). Extended:

1. Load the route's island manifest (built above).
2. JSON-roundtrip the loader data ONCE (the same bytes the SAB carries), so
   server-island props and the client's `data-brust-props` are byte-identical
   (review Fix 5 — see invariants).
3. For each island: resolve `props = pathInto(roundtrippedData, propsPath)`,
   produce the attribute-safe `island_<id>_props` string. For `ssr` islands
   additionally import the component **server-side** from its `island.config.ts`
   source `.tsx` path (resolved gating Q1; `renderToString` is already wired,
   `routes.ts:2`) and
   `renderToString(createElement(Component, props))` → `island_<id>_html`.
4. Build the jinja context = `{ ...loaderData, island_<id>_props, island_<id>_html? }`.
   Client-only islands contribute `_props` but no `_html`.
5. Serialize that context into the SAB and call `napiRenderJinja` as today —
   unchanged fast-lane contract (sync, returns the framed `u32` length;
   `lib.rs:613` `napi_render_jinja`). Adding per-island `renderToString` is CPU
   inside the SAME loader crossing; it adds NO new napi crossing.

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
`propsPath: "data.counter"` (the FULL dotted path, root included — corrected
during impl: the jinja context root IS the loader return whose top-level keys are
the destructured prop names, e.g. the `NativeProfile` fixture's `{user, greeting}`;
so the runtime resolves `pathInto(loaderReturn, "data.counter")`. A leaf-only
`"counter"` would wrongly resolve `loaderReturn.counter`. `props={counter}` with
`counter` destructured → `propsPath: "counter"`.) The same value feeds both `renderToString` (server
island) and the pre-serialized `data-brust-props` string. This keeps the prop
resolvable in both Rust/jinja and JS without an expression evaluator. Object
literals and computed expressions are a Non-goal for v1.

**Legal prop-expression shapes (review Fix 7).** The path is extracted by the
dedicated `<Island>` handler, NOT normal lowering (normal lowering rejects
member chains deeper than one segment — `lower.rs:776-782`). v1 accepts a
single member access off the loader binding (`data.counter`, or the destructured
`counter`). Deeper paths (`data.a.b`) and bare identifiers that aren't the loader
value are rejected at compile time with a clear error. The plan must specify the
exact accepted AST shapes.

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
- **Hydration correctness (review Fix 5).** For `ssr` islands the markup
  `renderToString` produces inside the mount MUST equal what the client chunk
  renders. The shared `propsPath` guarantees the same path; it does NOT
  guarantee the same VALUE representation — the client gets props via
  `JSON.parse(data-brust-props)` while a naive server render would use the raw
  loader object (a `Date`/`Map`/`undefined`/class instance roundtrips
  differently → mismatch). Invariant: the server island renders from the
  JSON-roundtripped value (the same bytes written to `data-brust-props` / the
  SAB), not the raw loader return.
- **No island ⇒ no bootstrap.** A native route with no `<Island>` emits no
  importmap/bootstrap script and behaves exactly as today.
- **SSR-island failure is contained.** If a server-island `renderToString`
  throws, fall back to client-only for that island (emit empty mount + props)
  rather than 500-ing the page; log it. (The loader-throw path already 500s the
  whole page; island-render-throw should degrade, not fail the shell.)

## Tests

- **Compiler (Rust, golden):** a fixture JSX with `<Island>` (client-only and
  `ssr`) emits the expected jinja marker, the `data-brust-props="{{ island_<id>_props }}"`
  attribute slot (reads the JS-pre-serialized, attribute-safe string from the
  context — NOT `| tojson`, which is unavailable; see "Resolved by spec review"
  OQ1), the `{{ island_<id>_html | safe }}` slot (ssr) / no slot (client-only),
  the `data-brust-csr` marker on client-only islands, and the baked bootstrap
  exactly once.
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
- **CSS for island components on native pages is unsolved (review Fix 8).** The
  React path injects per-route CSS in its buffering sink
  (`stream.ts:132-133`); `napi_render_jinja` (`lib.rs:621-700`) injects no CSS
  (`css_dir` state at `lib.rs:46` is unused on this path). An island shipping
  styles on a native page has no link-injection mechanism in v1. Either treat
  island CSS on native pages as a Non-goal for v1, or add a link-injection step
  to the native branch — plan-time decision.
- **No dev hot-reload for native islands.** Native templates are boot-only
  (`native-routes-emit.ts` header; `jinja.rs` `OnceLock`); the manifest +
  baked bootstrap inherit that — editing an island `.tsx` needs a restart.
- SEO visibility applies to `ssr` islands only; client-only islands are empty
  in the served HTML.
- **Native island ids must match `[A-Za-z0-9_]+` (no hyphens).** The id is
  embedded into the jinja context KEY `island_<id>_props` / `island_<id>_html`;
  a hyphen would make minijinja parse the key as subtraction. The compiler
  rejects hyphenated explicit `id="..."`; component-name defaults are inherently
  safe. (The React-path `isValidIslandId` is laxer — `[A-Za-z0-9_-]+` — so a
  hyphenated id usable on the React path is NOT usable as a native island.)

## Resolved by spec review

- **OQ1 `tojson`** → ABSENT (minijinja 2.20 default features, no `json`). Decision:
  JS pre-serializes attribute-safe props; do NOT rely on `tojson`. (See "Island
  prop serialization".)
- **OQ3 empty-mount detection** → use an explicit `data-brust-csr` attribute the
  compiler emits, not `childNodes.length` (whitespace nodes are unreliable).
- **OQ5 hydrate triggers** → stand; `hydrateMarkersIn` (`bootstrap.ts:118-127`)
  already wraps both root kinds, so triggers apply uniformly.
- **importmap entries** → none needed per-island (islands are URL-dynamic-
  imported, `bootstrap.ts:86`); only react/jsx-runtime/react-dom/client are
  mapped. `createRoot` is importable (`_entries/react-dom.ts` re-exports it).

## Gating questions — RESOLVED at plan-time (2026-05-29, empirical probe)

The three questions the review flagged as gating `ssr` mode were resolved by
inspecting the actual code before planning:

1. **Server-island component module resolution → IMPORT THE `.tsx` SOURCE.**
   Confirmed: `island.config.ts` entries ARE source `.tsx` paths
   (`example/hello-world/island.config.ts`: `Counter: './components/Counter.tsx'`;
   `tests/fixtures/app/island.config.ts` likewise). Bun runs TSX directly, so the
   worker resolves the island's source path from `island.config.ts` and
   `await import(sourcePath)` → `renderToString(createElement(Component, props))`.
   This is CPU inside the existing loader crossing (`routes.ts:548-585`, between
   the loader call and `napiRenderJinja`) — no new napi crossing. Risk: a
   component touching browser globals at module-eval time fails the server import;
   that degrades per-island to client-only (the contained-failure invariant
   above), same as any SSR framework. The `/_brust/islands/<id>.js` BROWSER bundle
   is still used for client hydration; the `.tsx` source is used only for the
   server render — two consumers of one registry entry.
2. **Attribute-safe serialization → JS-side entity-encode.** The native branch
   (TS) does `JSON.stringify(props)` then HTML-entity-encodes `&`, `<`, `>`, `"`
   and passes the result as `island_<id>_props` in the jinja context. Rust/minijinja
   is untouched (preserves the "compile-time pre-escape, no runtime autoescape"
   invariant, `emit_jinja.rs:156-185`); `tojson` stays unused.
3. **Registry → ONE registry (`island.config.ts`), validate don't merge.** Native
   islands MUST be registered in `island.config.ts` like React-path islands.
   Because `cfg.islands` is `Record<id, sourcePath>`, ids are unique by
   construction and the worker resolves the SSR source path from it directly. The
   compiler's per-route manifest carries `{id, propsPath, ssr, hydrate}` (NOT the
   import path); the build VALIDATES every native-island id ∈ `island.config.ts`
   keys (clear error on a missing registration) rather than merging two registries.
   The id-collision concern in "Build pipeline" evaporates under one registry.

## Open questions (non-gating; resolve during planning)

1. **CSS for island components on native pages** (Known limitations) — Non-goal
   v1, or add link-injection to the native branch? Leaning Non-goal v1.
2. **Bootstrap markup single-source-of-truth across Rust and JS.** Bake via the
   TS build step post-processing the emitted template (one source in
   `importmap.ts`) rather than codegen-ing the string into the Rust compiler.
3. **`<Outlet>` / layout interaction** for a native leaf vs the bootstrap
   injection point — the native template is a single emitted file; define where
   the baked bootstrap lands relative to any layout wrapper.
