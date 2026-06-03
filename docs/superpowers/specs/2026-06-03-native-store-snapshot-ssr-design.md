# Native store-snapshot SSR injection (B7) — design

**Status:** approved (brainstormed 2026-06-03) · **Branch:** `feat/b6-dx-hardening`

## Goal

When a `native: true` (minijinja) route renders a full document server-side, seed
every `defineStore` global store that the route's loaders touched into the HTML
so the client hydrates from server state instead of the store factory's defaults.
This closes the native-route half of the store-SSR story: React routes already
inject this snapshot (`runtime/render/inject-store.ts` + `collectSnapshot()` in
`runtime/routes.ts`); native routes deliberately did not (`routes.ts` comment:
"No snapshot is collected and no `<script>` is injected on native paths").

## Non-goals (out of scope for this pass — named explicitly)

- **`x-data` local component state.** Native single-file component instance state
  is seeded via the `x-props` JSON attribute already; not touched here.
- **SPA navigation payload store delivery.** The `/_brust/page/*` native nav path
  returns a `{html,title}` fragment, not a full document. React nav uses
  `runtime/store/client-hydrate.ts` to apply a nav-payload snapshot to live
  stores; the native equivalent is a separate future pass. This spec covers
  **initial full-document SSR only**.
- **Rust-side or post-process injection.** Rejected approaches (see below).
- **Client-side changes.** `defineStore` already hydrates from the injected
  `<script>` on first access (`runtime/store/define-store.ts:113-115`). No client
  edit is in scope; reusing `storeScriptTag` keeps hydration byte-identical to the
  React path.

## High-level architecture — Jinja context slot

`napiRenderJinja` is a synchronous Rust-side fast-lane call: it renders the
template, frames the HTTP response into the SAB, and returns only the byte
length. The JS side never sees the rendered HTML bytes, so the React path's
post-render splice (`injectBrustStore`) cannot be reused on native routes
without abandoning the fast lane.

Instead, the snapshot rides the **same context-variable mechanism** the native
island/component pipeline already uses (`island_<n>_props`, `comp_<n>_html`):

1. The compiler emits a framework-owned slot `{{ __brust_store__ | safe }}` into
   the document `<head>` (before `</head>`).
2. The JS native branch computes the store-`<script>` string and passes it as the
   `__brust_store__` render-context variable.
3. minijinja substitutes it during the normal render — no Rust server change, no
   compiler change to the render fast lane, fast lane preserved.

### Rejected approaches

- **Rust-side splice in `napiRenderJinja`** — invasive to the perf-sensitive
  render fast lane; duplicates the `</head>`-splice logic already in TS.
- **Render-to-string + `injectBrustStore` in JS** — bypasses the sync fast lane
  (extra napi round-trip returning a string), a perf regression on the hottest
  native path. The fast lane is the reason native routes exist.

## Touch points (3 production files)

### 1. `crates/jsx-rust-compiler/src/emit_jinja.rs` — Document shell

In the `JsxNode::Document` arm, immediately before `out.push_str("</head><body")`
(currently ~line 151, after the app.css `<link>` and the `head={[…]}` entries),
emit the slot:

```rust
// B7 store-snapshot SSR: a framework-owned slot the JS native renderer fills
// with the defineStore snapshot <script>(s) (empty string when no store was
// touched). RAW because it is framework-controlled markup, not a user value;
// brust's minijinja is AutoEscape::None, so a bare `{{ }}` is already raw —
// `| safe` documents intent and survives any future autoescape change.
out.push_str("{{ __brust_store__ | safe }}");
```

Only `JsxNode::Document` (the `<BrustPage>` full-document shell) carries the slot.
Native fragment/layout templates that do not render a document have no `<head>`
and correctly get no slot — matching the "full-document SSR only" scope.

### 2. `runtime/routes.ts` — native branch

- Import `buildStoreScripts` from `./render/inject-store.ts`. (The React
  *streaming* path already calls `buildStoreScripts`/`injectBrustStore` —
  `runtime/render/stream.ts:158,220`; the module is live, not dead code. Native is
  its first **standalone** caller: it uses `buildStoreScripts` to produce the
  `<script>` string for the jinja context var, without `injectBrustStore`'s
  post-render byte-splice, which the fast lane cannot use.) `collectSnapshot` is
  already imported (line 13).
- The native loader closure at ~line 740 is currently a non-async arrow
  (`() => runNativeChainLoaders(flat.chain, ctx)`). It must become `async` so the
  snapshot can be collected **after** loaders resolve but **inside** the scope —
  the only point where native store writes happen (the render is Rust-side and
  touches no store), and `collectSnapshot()` must run while the AsyncLocalStorage
  store scope is still open (mirrors the React pattern at `routes.ts:866-885`):

  ```ts
  let storeSnapshot: Record<string, Record<string, unknown>> | null = null
  // …
  chainResult = await runInRequestContext(call.req?.cookies ?? {}, async () => {
    const r = await runNativeChainLoaders(flat.chain, ctx)
    storeSnapshot = collectSnapshot()
    return r
  })
  ```

- After `data` is finalized (the `if ('verdict' in chainResult)` / `else` block,
  ~line 768/770) and **before** `const json = JSON.stringify(data)` (~line 772),
  attach the script string to the render data:

  ```ts
  if (data && typeof data === 'object') {
    ;(data as Record<string, unknown>).__brust_store__ = buildStoreScripts(storeSnapshot)
  }
  ```

  `buildStoreScripts(null)` returns `''`, so `__brust_store__` is **always** a
  string. `data` is typed `Record<string, unknown>` in both the verdict and else
  branches, so the `typeof data === 'object'` guard is dead-defensive (always
  true) — kept only as belt-and-braces. Both render sub-paths inherit the key for
  free: the island/component path parses `json` into `rt` (which now contains the
  key) and spreads it into `ctx`; the no-island path encodes `json` directly.

### 3. (no change) client + server.rs

`runtime/store/define-store.ts` (~line 114) already hydrates a store on first
access via `document.querySelector('script[data-brust-store="<name>"]')` →
`parseStoreScript(el)`. The tag carries `type="application/json"
data-brust-store="<name>"` (no `id`). Because native and React both emit via the
same `storeScriptTag`, the injected `<script>` is byte-identical and the existing
client hydration path works unmodified — the parity test (Tests §4) asserts the
`data-brust-store` attribute + `type`, not an `id`.

## Data flow

```
native loader writes defineStore('cart', …)   (inside runInRequestContext / ALS scope)
  → collectSnapshot()                          (after loaders, still in scope)
  → buildStoreScripts(snapshot)                (storeScriptTag per touched store; null→'')
  → data.__brust_store__ = scripts             (before JSON.stringify(data))
  → render context var __brust_store__
  → jinja slot `{{ __brust_store__ | safe }}`  emits <script type="application/json" …> in <head>
  → client defineStore('cart', …) first access → parseStoreScript → hydrate
```

## Tests (TDD)

1. **Compiler golden (Rust, `emit_jinja.rs` or `lib.rs` test):** a `Document`
   node emits `{{ __brust_store__ | safe }}` exactly once, positioned after the
   app.css `<link>` and before `</head>`. A non-document native node emits no
   slot.
2. **Runtime unit (`inject-store.test.ts`, already exists):** confirm
   `buildStoreScripts({cart:{count:1}})` equals `storeScriptTag('cart',{count:1})`
   and `buildStoreScripts(null) === ''` (lock the contract the native path relies
   on; extend existing coverage if not already asserted).
3. **Runtime integration (new fixture native route whose loader writes a
   defineStore):** served full-document HTML for that route contains the store
   `<script>` in `<head>` with the loader-set value; a native route whose loader
   touches no store contains no store `<script>` (slot renders `''`).
4. **Hydration parity:** the integration test asserts the injected `<script>`
   shape matches what `storeScriptTag` produces (same id/type), proving the
   existing client `defineStore` hydration consumes it without change.

## Acceptance criteria

- A native full-document route whose loader writes `defineStore` state serves
  that state as a `<script type="application/json">` inside `<head>`, consumable
  by the unmodified client `defineStore` hydration.
- A native route that touches no store serves no store `<script>` (no empty/dummy
  tag, no minijinja undefined error).
- Fast lane unchanged: `napiRenderJinja` still returns a length; no JS
  render-to-string detour.
- All existing gates green: `cargo fmt`/`clippy --all-targets --locked -D warnings`/`cargo test --workspace`,
  `bun run ci` (biome), `bun run typecheck:treaty`, `bun test runtime/`, native
  integration files (run separately), napi rebuilt after the Rust edit.

## Known limitations

- SPA-nav store delivery for native routes remains unimplemented (non-goal).
- The slot is emitted for every native Document even when no store exists; cost is
  one minijinja variable substitution rendering `''` — negligible.

## Open questions resolved at plan-time

- **Where exactly the slot sits:** after the framework `head={[…]}` loop, before
  `</head>`, so user-authored `<head>` entries are unaffected and the store script
  is last in `<head>` (consistent with React's "before first `</head>`" splice).
- **Undefined safety:** brust's minijinja (`Environment::new()`, `UndefinedBehavior::Chainable`,
  minijinja 2.20.0) renders an undefined `{{ x | safe }}` as `''` with **no error**
  (empirically verified during spec review). Always setting `__brust_store__` to
  `''` is therefore defensive, not strictly required — kept to future-proof against
  an undefined-behavior change.
- **XSS / tag-breakout:** SAFE. `storeScriptTag` escapes the JSON via `toScriptJson`
  (`< > & U+2028 U+2029` → `\uXXXX`) and sanitizes the store `name`, so
  request-derived store state cannot break out of the `<script>` (verified in
  review; consistent with the `brust-jinja-autoescape-none` memory).
