# Spec A — Isomorphic store core

> **Status:** design (rev 2, post-review) · 2026-06-02 · target release 0.1.21-alpha
> **Decomposition:** This is **Spec A** of a two-spec feature.
> - **Spec A (this doc):** the isomorphic reactive store — reactivity core
>   (`signal`/`computed`/`effect`/`batch`), `defineStore` with a client `window`
>   singleton + a server per-request `AsyncLocalStorage` scope, snapshot
>   serialize→`<script>`→client hydrate **on the React rendering paths only**, and
>   a React `useStore` adapter. **Touches no Rust and no compiler.** Fixes **S4**
>   (cross-island shared state) and **S6** (per-request server isolation).
> - **Spec B (separate, later):** native interactivity. **Native stays exactly as
>   it is today** (jinja compiled in Rust — no compiler change). Interactivity is
>   added by a **separate client `<script>` runtime** plus **Alpine.js-style DOM
>   directives** (`x-text` / `x-show` / `x-on:click` / `x-data` or a `b-*` variant)
>   that the runtime scans and binds to this store. Spec B also delivers the store
>   snapshot into native pages via that separate script. **Spec A does not inject
>   anything into native HTML.**

## Goal

Give brust apps one reactive store that is the single source of truth for shared
state, addressing two confirmed gaps in `example/pokedex/FRAMEWORK-GAPS.md`:

- **S4** — two React islands are separate Bun.build bundles; a module-scope store
  imported by both is duplicated into two instances that never sync. Today the
  pokedex hand-rolls a `window` CustomEvent bus (`components/team-bus.ts`).
- **S6** — the team store is a module-scope `Map`, shared across every request and
  every visitor. There is no per-request/session isolation.

Spec A delivers:

1. A tiny framework-agnostic **reactivity core**: `signal`, `computed`, `effect`,
   `batch`. (`effect` is the primitive Spec B's Alpine-style runtime binds DOM with;
   it is included here because the core is one cohesive module, even though Spec A's
   own `useStore` uses `subscribe`, not `effect`.)
2. **`defineStore(name, factory)`** — a named store whose identity is:
   - **client**: a single instance per `name` on a `window` registry (fixes S4 —
     every island bundle resolves the same object),
   - **server**: a per-request instance held in `AsyncLocalStorage` (fixes S6 — two
     concurrent requests in one worker never see each other's state).
3. **Snapshot serialize → `<script>` → client hydrate, on the React paths**, so
   server-seeded state arrives on the client without a flash and without a second
   fetch. (Native pages get the snapshot via Spec B's separate script.)
4. **`useStore(store)`** — a React adapter (`useSyncExternalStore`) so existing React
   islands consume the shared store with no authoring change beyond the import.
5. A **loader seed API**: a loader mutates the store by importing it and calling
   setters; the per-request scope makes that safe on the server.

## Non-goals (loud)

- **No native HTML injection.** Spec A does **not** put a store `<script>` into a
  native (jinja) page, does **not** add a jinja placeholder, does **not** touch
  `runtime/cli/native-routes-emit.ts` or `crates/jsx-rust-compiler`. Native snapshot
  delivery + native interactivity are entirely Spec B (separate script + Alpine-style
  directives). The native paths in Spec A only get the (forward-compatible) server
  ALS scope so a native loader's store writes are per-request-correct — but nothing
  is emitted into native HTML.
- **No Rust changes. No compiler changes.** `cargo test` baselines must be untouched.
- **No `brustjs/client` reactive renderer, no JSX→real-DOM, no `useLoaderData`,
  `useSignal`, `<Show>`, `<For>`.** The earlier SolidJS-style isomorphic-renderer
  direction is dropped. Spec B is Alpine-style directives, not a renderer.
- **No persistence adapters** (localStorage/cookies/IndexedDB), **no cross-tab
  sync**, **no devtools/time-travel/middleware**.
- **No rewrite of the pokedex.** `team-bus.ts` stays until a later dogfood step.
  Spec A ships the primitive + tests, not an example migration.

## High-level architecture

```
brustjs/store  (isomorphic, NO react, NO dom)
  signal/computed/effect/batch  ── reactive core (dependency tracking + notify)
  defineStore(name, fn)         ── returns a StoreHandle & S (proxy over active instance)
        │
        ├── client: window.__BRUST_STORES__[name]  (lazy singleton, fixes S4)
        │            hydrated on first access from <script data-brust-store="name">
        │
        └── server: AsyncLocalStorage<Map<name,instance>>  (per-request, fixes S6)
                     factory() on first access in-scope; access out-of-scope throws

brustjs  (main entry, react-aware)
  useStore(store) ── useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot)
                     returns PLAIN VALUES (computeds evaluated): t.count, not t.count()

render pipeline  (per request)
  runInStoreContext(() => { run loaders; render })   ← server ALS scope (ALL paths)
  collectSnapshot()  → { name: {sigKey: value, ...}, ... }   (only touched stores)
        ├── React initial (buffering) : injectBrustStore(body, snap)       stream.ts
        ├── React initial (streaming) : append store <script> to first chunk stream.ts
        ├── React SPA nav             : JSON {html,title,store}             routes.ts
        └── native (initial + nav)    : ALS scope only — NO injection (Spec B)
```

### Reactivity core (`runtime/store/signal.ts`)

Pull-based reactive system (push-on-write, pull-on-read), synchronous notify:

- `signal<T>(initial: T): Signal<T>` — callable: `s()` reads (registers a dependency
  inside an active `effect`/`computed`); `s.set(next: T | (prev:T)=>T)` writes and
  notifies dependents only if the value changed (`Object.is` guard).
- `computed<T>(fn: () => T): Computed<T>` — callable `c()`; memoized; recomputes
  lazily when a dependency changed; read-only (no `.set`).
- `effect(fn: () => void): () => void` — runs immediately, re-runs when a tracked
  read changes; returns a dispose fn. (Client-meaningful; on the server it runs once
  and is not retained — documented limitation. Spec A doesn't use it; Spec B does.)
- `batch(fn: () => void): void` — coalesce multiple `.set` into one notification pass.

Brands: signals carry `Symbol('brust.signal')`, computeds `Symbol('brust.computed')`,
used by `defineStore` to classify serializable writable state.

### `defineStore` (`runtime/store/define-store.ts`)

```ts
export interface StoreHandle<S extends object> {
  (): S                                   // resolve active instance (client singleton / server per-request)
  readonly name: string
  subscribe(cb: () => void): () => void   // any-change subscription (React adapter)
  snapshot(): Snapshot<S>                 // stable plain-value snapshot (computeds evaluated)
  serialize(): Record<string, unknown>    // writable-signal state → JSON-safe object
  hydrate(state: Record<string, unknown>): void  // set writable signals from a serialized object
}
export function defineStore<S extends object>(name: string, factory: () => S): StoreHandle<S> & S
```

`defineStore` returns a **handle that is also a property proxy**: `team.members`,
`team.add`, `team.count` resolve against the *active instance*, so authors write
`team.members.set(x)` directly (no `team().members`). Implemented with a `Proxy`
whose `get` resolves the active instance then reads the property. The bare call
`team()` and the reserved keys (`name`/`subscribe`/`snapshot`/`serialize`/`hydrate`)
are served by the handle itself; everything else proxies to the instance.

**Active-instance resolution:**

- `typeof window !== 'undefined'` → **client**. Instance at
  `window.__BRUST_STORES__[name]` (created once). On first access with no entry:
  run `factory()`, store it, then **hydrate** from a
  `<script type="application/json" data-brust-store="<name>">` element if present
  (idempotent — re-hydration with the same payload is a no-op-equivalent set).
- else → **server**. Instance in `storeContext.getStore()` (an
  `AsyncLocalStorage<Map<string, StoreRecord>>`). First access in-scope: run
  `factory()`, store `{ instance, handle }` in the map. Access with **no active
  scope** → throw `"store '<name>' accessed outside a request scope"` (a server
  singleton is exactly the S6 bug).

**Serialize/snapshot classification:** walk the instance's own enumerable keys.
`signal`-branded → `serialize` includes `key: value()`; `computed`-branded →
`snapshot` includes the evaluated value but `serialize` excludes it (recomputed on
hydrate); functions/other → excluded from both.

### Server per-request scope (`runtime/store/server-context.ts`)

```ts
export const storeContext = new AsyncLocalStorage<Map<string, StoreRecord>>()
export function runInStoreContext<T>(fn: () => T): T          // storeContext.run(new Map(), fn)
export function collectSnapshot(): Record<string, Record<string, unknown>> | null
//   reads active Map; returns { [name]: record.handle.serialize() } for touched stores,
//   or null if no store was used this request (non-store apps inject nothing).
```

**Wiring** (server ALS scope wraps the loader+render span on **all** paths so S6 is
correct everywhere; snapshot **injection** happens on **React paths only**):

| Path | File:line (verify before edit) | Spec A change |
|---|---|---|
| React initial — buffering | `runtime/render/stream.ts` ~144-160 (`final` assembly, beside `injectCssLink`/`injectDevClient`/`injectActionPrefix`) | wrap render span in `runInStoreContext`; `injectBrustStore(body, snap)` |
| React initial — streaming | `runtime/render/stream.ts` ~195-244 (hand-assembled first chunk ~207-215) | append store `<script>` to the first-chunk prefix string (the buffering inject helper is bypassed here — see B2) |
| React SPA nav | `runtime/routes.ts` ~974 (`navigationBranch` JSON) | wrap; add `store: snap` to `JSON.stringify({ html, title, store })`; `bootstrap.ts navigate()` applies it client-side |
| native initial | `runtime/routes.ts` ~633-737 (native branch; fast-lane `napiRenderJinja` returns a length at ~732) | wrap loader in `runInStoreContext` ONLY — **no injection** (Spec B) |
| native SPA nav | `runtime/routes.ts` ~1001-1052 (`renderNativeRouteToHtml`, napi at ~1041) | wrap loader ONLY — **no injection** (Spec B) |

> The exact line numbers above are approximate (rev-1 review found three of four
> stale); the implementer MUST re-locate each by the anchor description, not the
> number.

### React adapter (`runtime/store/react.ts`, re-exported from `brustjs`)

```ts
export function useStore<S extends object>(store: StoreHandle<S> & S): Snapshot<S>
//   useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot)
//   3rd arg = server snapshot (same fn) so SSR + first client snapshot agree (no mismatch).
```

Returns plain values: `const t = useStore(team); t.count` (number), `t.members`
(array) — NOT functions. Exported from the `brustjs` main entry
(`runtime/index.ts`), NOT from `brustjs/client` (react-free) and NOT from
`brustjs/store` (react-free). There is no `brustjs/react` package — islands import
`useStore` from `brustjs`, which they already import from.

### Client snapshot application on SPA nav (`runtime/store/client-hydrate.ts`)

```ts
export function applyStoreSnapshot(snap: Record<string, Record<string, unknown>>): void
//   for each [name, state]: if window.__BRUST_STORES__[name] exists, call the
//   instance's hydrate(state). A store whose handle hasn't been defineStore'd yet on
//   the client is skipped (its lazy first-access hydration reads the initial-load
//   <script>, not nav state — nav state for a not-yet-active store is dropped; the
//   page's islands import their handles, so active stores are covered).
```

`bootstrap.ts navigate()` reads `store` from the nav JSON and calls
`applyStoreSnapshot(store)` after `swapMainContent` but before `hydrateMarkersIn`
(so freshly-hydrated islands read up-to-date state).

### Serialization format & XSS safety (`runtime/store/serialize.ts`)

Embedded as one `<script>` per touched store:

```html
<script type="application/json" data-brust-store="team">{"members":[…],"max":6}</script>
```

`toScriptJson(value)` = `JSON.stringify(value)` then escape the result so it cannot
break out of a `<script>` text node (brust runs `AutoEscape::None`; a request-derived
value reaching a serialized signal is a real XSS vector — cf. memory
`brust-jinja-autoescape-none`). This is a **`<script>` text-content** context, which
is different from the island `data-brust-props` **attribute** context
(`island.tsx:77`, react-attribute-escaped) — do NOT model the escape on island props.
Exact replacements on the JSON string:

- `<` → `<`   (kills `</script>` and `<!--`)
- `>` → `>`
- `&` → `&`
- ` ` → ` `, ` ` → ` ` (JS line-terminator safety)

All four/five are valid inside a JS string literal and survive `JSON.parse`. Client
reads `JSON.parse(scriptEl.textContent)`. A unit test asserts a value containing the
literal `</script>` produces serialized text with **no** literal `</script>`.

## File structure

```
runtime/store/
  signal.ts            # signal, computed, effect, batch + brands             (new)
  define-store.ts      # defineStore, StoreHandle, proxy, client singleton     (new)
  server-context.ts    # AsyncLocalStorage scope, runInStoreContext, collectSnapshot (new)
  serialize.ts         # toScriptJson (XSS-safe), parseStoreScript, snapshot <script> string (new)
  client-hydrate.ts    # applyStoreSnapshot (SPA-nav)                          (new)
  react.ts             # useStore (imports react) — NOT re-exported by index.ts (new)
  index.ts             # brustjs/store barrel: signal/computed/effect/batch/defineStore
                       #   MUST NOT re-export react.ts (keeps ./store react-free) (new)
runtime/render/
  inject-store.ts      # injectBrustStore(body: Uint8Array, snap) → Uint8Array (mirrors inject-action-prefix.ts) (new)
runtime/index.ts       # + export { useStore } from './store/react.ts'         (edit)
runtime/islands/bootstrap.ts  # navigate(): read `store`, applyStoreSnapshot   (edit)
runtime/render/stream.ts      # wrap react spans + inject (buffering + streaming first chunk) (edit)
runtime/routes.ts             # wrap all loader sites in runInStoreContext; React-nav store field (edit)
package.json                  # + "./store": "./runtime/store/index.ts" in exports (edit)
```

## Behavior / concurrency invariants

1. **Client identity (S4):** for a `name`, every `defineStore(name, …)` call in any
   island bundle on the same document resolves to the **same** instance. A write in
   island A is observed by `subscribe` in island B.
2. **Server isolation (S6):** two requests on the same worker, interleaved at loader
   `await` points, each see their own instance; neither observes the other's writes.
   Out-of-scope access throws.
3. **No flash (React paths):** the snapshot serialized after the loader equals the
   state the client hydrates → React's hydrate snapshot matches SSR.
4. **`Object.is` change guard:** `signal.set` to an equal value notifies nobody.
5. **Touched-only serialization:** stores never accessed in a request emit no `<script>`.

## Tests

Unit (`bun test`, happy-dom where DOM is needed):

- `runtime/store/signal.test.ts` — signal read/write/notify; computed memoize + lazy
  recompute; effect re-run + dispose; batch coalescing; `Object.is` guard.
- `runtime/store/define-store.test.ts` — proxy read/write to active instance;
  `serialize` = signals only; `hydrate` round-trip; `snapshot` evaluates computeds &
  is referentially stable until a change.
- `runtime/store/client-singleton.test.ts` (happy-dom) — two handle objects resolve
  the same `window.__BRUST_STORES__.x`; cross-`subscribe` sync; first access hydrates
  from an injected `<script data-brust-store="x">`.
- `runtime/store/server-context.test.ts` — `runInStoreContext` isolates two
  concurrent scopes (interleave via `await`); out-of-scope access throws;
  `collectSnapshot` returns only touched stores; returns null when none used.
- `runtime/store/serialize.test.ts` — `toScriptJson` escapes `</script>`, `<!--`,
  `&`, U+2028/9; `parseStoreScript` round-trips; a `</script>`-bearing string value
  cannot break out.
- `runtime/store/react.test.ts` (happy-dom) — `useStore` re-renders on change; SSR
  snapshot == first client snapshot (no mismatch).

Integration (`tests/` — boots the server; **rebuild the addon first** per repo rule):

- `tests/store-isomorphic.test.ts` — a **React-path** route whose loader seeds a
  store → response HTML contains `<script data-brust-store="…">` with the seeded
  state; two requests with different seeds get different payloads (S6); the served
  page hydrates the store from that script (assert by parsing the script payload in
  the response, no second fetch). Native pages are explicitly out of scope here.

## Acceptance criteria

- `bun run ci` (biome) clean — this is the lint gate (NOT `tsc`, which stack-overflows
  on this repo; cf. memory `brust-ts-ci-gates-biome-not-cargo`).
- New unit suites green; existing `runtime` suite still green (rev-1 baseline **297**;
  re-measure at impl time — treat as "no regressions vs the count on this branch's
  base", not a frozen literal).
- `cargo test` baselines **unchanged** (Spec A touches no Rust): jsx-rust-compiler,
  brust lib.
- Integration suite green + the new `store-isomorphic` test.
- `brustjs/store` resolves (`import { defineStore, signal } from 'brustjs/store'`
  runs under `bun test`); `import { useStore } from 'brustjs'` resolves at runtime in
  a bun-test fixture. (No tsc-based criterion — biome is the only static gate.)
- S4 demonstrated by `client-singleton.test.ts` (two handles, one singleton, sync).
- S6 demonstrated by `server-context.test.ts` (two scopes isolated).

## Known limitations (shipped intentionally)

- Native pages get no store `<script>` in Spec A — they remain non-interactive until
  Spec B adds the separate Alpine-style script (which also delivers the native
  snapshot). Spec A only wraps native loaders in the ALS scope for forward-compat.
- React **streaming/Suspense** routes: snapshot rides in the hand-assembled first
  chunk (covered), but if a store is only first-touched inside a suspended boundary
  that flushes after the first chunk, its snapshot may be incomplete — document; the
  team/cart/selection stores these target are seeded in the loader (pre-render), so
  this edge does not bite them.
- `effect` is client-meaningful only; server runs it once and discards.
- Snapshot is whole-state per touched store (no delta) — fine at this scale.
- pokedex keeps `team-bus.ts`; migration deferred.

## Open questions resolved at plan-time

1. **ALS survival across the render boundary** — rev-1 review traced it: the renderer
   is one `async` fn per request; React `renderToPipeableStream` uses microtasks +
   Writable callbacks, and ALS context propagates through those within the same async
   root; native `napiRenderJinja` is synchronous (trivially in-context). No existing
   ALS usage to copy. **The plan MUST land `server-context.test.ts` proving
   interleave isolation BEFORE wiring `routes.ts`/`stream.ts`** (TDD order), so the
   BLOCKED fallback is chosen on evidence, not after a wide edit.
2. **`Snapshot<S>` type** — mapped type: `Signal<T>`→`T`, `Computed<T>`→`T`, function
   properties dropped. `useStore` accepts `StoreHandle<S> & S` and returns
   `Snapshot<S>`. Plan defines it in `define-store.ts`.

## BLOCKED fallbacks

- **ALS leaky/unavailable in the worker render path:** fall back to a module-scope
  `let current: Map | null` set immediately before and cleared immediately after the
  *synchronous* render call, with loaders receiving the map via a 4th ctx field
  `stores` (less ergonomic on the server, but unblocks). Gate on
  `server-context.test.ts`.
- **`useSyncExternalStore` hydration mismatch:** if server snapshot ≠ first client
  snapshot, have `useStore`'s server-snapshot read the serialized `<script>` directly
  during hydration. Captured as a test.
