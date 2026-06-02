# Spec A — Isomorphic store core

> **Status:** design · 2026-06-02 · target release 0.1.21-alpha
> **Decomposition:** This is **Spec A** of a two-spec feature. Spec A ships the
> isomorphic store primitive (reactivity core + `defineStore` + per-request server
> scope + snapshot serialize/hydrate + React `useStore`). **Spec B** (separate,
> later) ships the `brustjs/client` real-DOM isomorphic renderer (`useLoaderData`,
> `Show`/`For`, compiler dual-emit) that consumes this store. Spec A has standalone
> value: it fixes **S4** (cross-island shared state) and **S6** (per-request server
> isolation) for React islands today, with zero compiler changes.

## Goal

Give brust apps one reactive store that is the single source of truth across every
rendering world, addressing two confirmed gaps in `example/pokedex/FRAMEWORK-GAPS.md`:

- **S4** — two React islands are separate Bun.build bundles; a module-scope store
  imported by both is duplicated into two instances that never sync. Today the
  pokedex hand-rolls a `window` CustomEvent bus (`components/team-bus.ts`).
- **S6** — the team store is a module-scope `Map`, shared across every request and
  every visitor. There is no per-request/session isolation.

Spec A delivers:

1. A tiny framework-agnostic **reactivity core**: `signal`, `computed`, `effect`.
2. **`defineStore(name, factory)`** — a named store whose identity is:
   - **client**: a single instance per `name` on a `window` registry (fixes S4 —
     every island bundle resolves the same object),
   - **server**: a per-request instance held in `AsyncLocalStorage` (fixes S6 — two
     concurrent requests in one worker never see each other's state).
3. **Snapshot serialize → `<script>` → client hydrate**, so server-seeded state
   arrives on the client without a flash and without a second fetch.
4. **`useStore(store)`** — a React adapter (`useSyncExternalStore`) so existing
   React islands consume the shared store with no authoring change beyond the import.
5. A **loader seed API**: a loader mutates the store by importing it and calling
   setters; the per-request scope makes that safe.

## Non-goals (loud — these are Spec B or out of scope entirely)

- **No `brustjs/client` real-DOM renderer.** No `useLoaderData`, `useSignal`,
  `useEffect`, `<Show>`, `<For>`, no JSX→real-DOM compile target. Spec B.
- **No compiler changes.** `crates/jsx-rust-compiler` is untouched. No dual-emit, no
  reactive-expression lowering, no jinja `{{ store.* }}` interpolation. Spec B will
  add jinja-side consumption; Spec A only *injects the snapshot into the jinja
  context object and the HTML* — it does not make any template read it.
- **No native-page reactivity.** A native (jinja) page does not become interactive
  from Spec A. Its only gain is that the store snapshot is present in context and in
  a `<script>` tag for a future client to pick up.
- **No persistence/storage adapters** (localStorage, cookies, IndexedDB). A loader
  may seed from a cookie manually; Spec A ships no built-in adapter.
- **No cross-tab / BroadcastChannel sync.** One document = one client store.
- **No devtools, no time-travel, no middleware/plugins.**
- **No replacement of `team-bus.ts`** in the pokedex within Spec A. Migrating the
  pokedex to the store is a dogfood step done in Spec B (or a follow-up), so the
  CustomEvent bus stays until then. Spec A adds the primitive + unit/integration
  coverage; it does not rewrite the example app.

## High-level architecture

```
brustjs/store  (isomorphic, NO react, NO dom)
  signal/computed/effect  ── reactive core (dependency tracking + notify)
  defineStore(name, fn)   ── returns a StoreHandle
        │
        ├── client: window.__BRUST_STORES__[name]  (lazy singleton, fixes S4)
        │            hydrated on first access from <script data-brust-store="name">
        │
        └── server: AsyncLocalStorage<Map<name,instance>>  (per-request, fixes S6)
                     created by factory() on first access within the request scope

brustjs  (main entry, react-aware)
  useStore(store) ── useSyncExternalStore(store.subscribe, store.snapshot)
                     returns PLAIN VALUES (computeds evaluated): t.count, not t.count()

render pipeline  (per request)
  runInStoreContext(() => { run loaders; render })   ← establishes server ALS scope
  collectSnapshot()  → { name: {sigKey: value, ...}, ... }   (only touched stores)
        ├── React initial : injectBrustStore(body, snap)         stream.ts
        ├── React SPA nav  : JSON {html,title,store}             routes.ts
        ├── native initial : ctx.__brustStore = snap (+ <script> appended)  routes.ts
        └── native SPA nav : ctx.__brustStore = snap (+ <script>)           routes.ts
```

### Reactivity core (`runtime/store/signal.ts`)

A minimal pull-based reactive system (push-on-write, pull-on-read), no scheduler
beyond synchronous notify:

- `signal<T>(initial: T): Signal<T>` — `Signal<T>` is a callable: `s()` reads (and,
  inside an `effect`/`computed`, registers a dependency); `s.set(next: T | (prev:T)=>T)`
  writes and notifies dependents if the value changed (`Object.is` guard).
- `computed<T>(fn: () => T): Computed<T>` — callable `c()`; memoized; recomputes
  lazily when a dependency changed; brand-tagged as read-only (no `.set`).
- `effect(fn: () => void): () => void` — runs `fn` immediately, re-runs when any
  signal/computed read during the last run changes; returns a dispose function.
- `batch(fn: () => void): void` — coalesce multiple `.set` calls into one
  notification pass (used by store actions that touch several signals).

Brands: signals carry `Symbol('brust.signal')`, computeds `Symbol('brust.computed')`.
Used by `defineStore` to classify which fields are serializable writable state.

> **Server semantics of `effect`:** during SSR an `effect` runs its body once
> (synchronously, for any setup) and is **not** retained/disposed across requests —
> effects are a client concern. `useStore` does not use `effect`; it uses `subscribe`
> (see below). Authors should not rely on effects on the server. (Documented limitation.)

### `defineStore` (`runtime/store/define-store.ts`)

```ts
export interface StoreHandle<S extends object> {
  /** Resolve the active instance (client singleton or server per-request). */
  (): S
  readonly name: string
  /** Subscribe to ANY change in the store; returns unsubscribe. (React adapter.) */
  subscribe(cb: () => void): () => void
  /** A stable plain-value snapshot for the active instance (computeds evaluated).
   *  Referentially stable until a signal changes (useSyncExternalStore contract). */
  snapshot(): Snapshot<S>
  /** Serialize the active instance's writable-signal state to a JSON-safe object. */
  serialize(): Record<string, unknown>
  /** Set the active instance's writable signals from a serialized object. */
  hydrate(state: Record<string, unknown>): void
}

export function defineStore<S extends object>(
  name: string,
  factory: () => S,
): StoreHandle<S> & S
```

`defineStore` returns a **handle that is also a property proxy**: `team.members`,
`team.add`, `team.count` resolve against the *active instance* (so authors write
`team.members.set(x)` directly, no `team().members`). Implemented with a `Proxy`
whose `get` resolves the active instance then reads the property. The bare call
`team()` and the handle methods (`subscribe`/`snapshot`/`serialize`/`hydrate`/`name`)
are reserved keys on the proxy.

**Active-instance resolution:**

- `typeof window !== 'undefined'` → client. Instance lives at
  `window.__BRUST_STORES__[name]` (a plain object created once). On first access,
  if the registry has no entry: run `factory()`, store it, then **hydrate** from a
  `<script type="application/json" data-brust-store="<name>">` element if present
  (read once, then the element may remain in the DOM; re-hydration is idempotent).
- else → server. Instance lives in `storeContext.getStore()` (an
  `AsyncLocalStorage<Map<string, unknown>>`). On first access within a request
  scope: run `factory()`, store in the map. **If accessed with no active scope**
  (e.g. at module top-level on the server) → throw a clear error
  (`"store '<name>' accessed outside a request scope"`), because a server singleton
  is exactly the S6 bug.

**Snapshot/serialize classification:** walk the instance's own enumerable keys.
For each value branded `signal` → include `key: value()` in serialize; branded
`computed` → include in `snapshot()` (evaluated) but **not** in serialize (recomputed
on hydrate); functions and everything else → skipped in both.

### Server per-request scope (`runtime/store/server-context.ts`)

```ts
export const storeContext = new AsyncLocalStorage<Map<string, unknown>>()
export function runInStoreContext<T>(fn: () => T): T   // storeContext.run(new Map(), fn)
export function collectSnapshot(): Record<string, Record<string, unknown>> | null
//   reads the active Map, calls each handle's serialize via a per-instance back-ref,
//   returns { [name]: serialized } for stores that were touched this request, or
//   null if no store was used (so non-store apps inject nothing).
```

Each store instance created on the server records `(name, handle)` in the request
Map so `collectSnapshot()` can serialize it without the caller enumerating handles.

**Wiring** — the render pipeline wraps the loader+render span in `runInStoreContext`
at the four sites the explore pass identified, then calls `collectSnapshot()` after
render and injects:

| Path | File:line (current) | Change |
|---|---|---|
| React initial | `runtime/render/stream.ts` ~150 (buffering assembly) | wrap render span; `injectBrustStore(body, snap)` alongside existing `injectCssLink`/`injectDevClient`/`injectActionPrefix` |
| React SPA nav | `runtime/routes.ts` ~974 (`navigationBranch`) | wrap; add `store: snap` to `JSON.stringify({html,title,...})`; client reads it in `bootstrap.ts navigate()` |
| native initial | `runtime/routes.ts` ~690 (native render branch) | wrap loader; merge `__brustStore: snap` into the jinja `ctx`; append the `<script>` to the rendered body (Rust returns body via SAB — see "native injection" below) |
| native SPA nav | `runtime/routes.ts` ~1022 (`renderNativeRouteToHtml`) | wrap; same merge + `<script>` |

> **native injection mechanism:** the native paths return the body Rust rendered via
> `napiRenderJinja` (SAB). Spec A appends the `<script data-brust-store>` tag to the
> `<main>`-extracted body **in JS** after the napi call returns, not via the template
> (no compiler change). For the initial native load (FAST LANE returns a length, body
> never crosses back to JS) we instead inject by **merging the snapshot into ctx and
> emitting the tag from a framework-owned trailer the renderer already controls** —
> see Open Questions resolved at plan-time #1.

### React adapter (`runtime/store/react.ts`, re-exported from `brustjs`)

```ts
export function useStore<S extends object>(store: StoreHandle<S> & S): Snapshot<S>
//   useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot)
//   third arg = server snapshot (same fn) so SSR + hydrate agree.
```

Returns plain values: `const t = useStore(team); t.count` (number), `t.members`
(array). NOT functions — that is the brust-client (Spec B) calling convention.
`useStore` is exported from the `brustjs` main entry (`runtime/index.ts`), NOT from
`brustjs/client` (which is react-free) and NOT from `brustjs/store` (which is
react-free). This matches the brainstorm decision: there is no `brustjs/react`
package; islands import `useStore` from `brustjs` (which they already import from).

### Serialization format & XSS safety

Snapshot JSON is embedded as:

```html
<script type="application/json" data-brust-store="team">{"members":[…],"max":6}</script>
```

The JSON string **must** be escaped against `</script>` / `<!--` breakout before
embedding (brust runs `AutoEscape::None`; a request-derived value reaching a signal
that is then serialized is a real XSS vector — cf. memory `brust-jinja-autoescape-none`).
Escaping rule: replace `<` → `<`, `>` → `>`, `&` → `&`,
` `/` ` → escaped. This is value-safe for `JSON.parse` and prevents tag
breakout. The client reads via `JSON.parse(scriptEl.textContent)`.

One `<script>` per touched store, all appended at the same injection point.

## File structure

```
runtime/store/
  signal.ts            # signal, computed, effect, batch + brands         (new)
  define-store.ts      # defineStore, StoreHandle, proxy, client singleton (new)
  server-context.ts    # AsyncLocalStorage scope, runInStoreContext, collectSnapshot (new)
  serialize.ts         # toScriptJson (XSS-safe), parseStoreScript, snapshot <script> emit (new)
  react.ts             # useStore (imports react)                         (new)
  index.ts             # brustjs/store barrel: signal/computed/effect/batch/defineStore (new)
runtime/render/
  inject-store.ts      # injectBrustStore(body: Uint8Array, snap) → Uint8Array (new, mirrors inject-action-prefix.ts)
runtime/index.ts       # + export { useStore } from './store/react.ts'    (edit)
runtime/islands/
  bootstrap.ts         # navigate(): read `store` from nav JSON → hydrate handles (edit)
package.json           # + "./store": "./runtime/store/index.ts" in exports (edit)
runtime/routes.ts      # wrap 3 sites in runInStoreContext + inject (edit)
runtime/render/stream.ts # wrap react-initial span + injectBrustStore (edit)
```

## Behavior / concurrency invariants

1. **Client identity (S4):** for a given `name`, every `defineStore(name, …)` call in
   any island bundle on the same document resolves to the **same** instance object.
   A write in island A is observed by `subscribe` in island B.
2. **Server isolation (S6):** two requests processed by the same worker, interleaved
   at loader `await` points, each see their **own** store instance. Neither observes
   the other's writes. A store accessed outside any request scope throws.
3. **No flash:** the snapshot serialized after the loader runs equals the state the
   client hydrates, so React's hydrate snapshot matches SSR (`useSyncExternalStore`
   server-snapshot path).
4. **`Object.is` change guard:** `signal.set` to an equal value notifies nobody.
5. **Touched-only serialization:** stores never accessed during a request emit no
   `<script>`.

## Tests

Unit (bun test, happy-dom where DOM is needed):

- `runtime/store/signal.test.ts` — signal read/write/notify; computed memoize +
  lazy recompute; effect re-run + dispose; batch coalescing; `Object.is` guard.
- `runtime/store/define-store.test.ts` — proxy property read/write to active
  instance; `serialize` includes signals only (not computed/functions); `hydrate`
  round-trips; `snapshot` evaluates computeds and is referentially stable until a
  change.
- `runtime/store/client-singleton.test.ts` (happy-dom) — two separate
  `defineStore('x',…)` handle objects resolve the same `window.__BRUST_STORES__.x`;
  write via one observed via the other's `subscribe`. First access hydrates from an
  injected `<script data-brust-store="x">`.
- `runtime/store/server-context.test.ts` — `runInStoreContext` isolates two
  concurrent scopes (interleave with `await` / `Promise`); access outside scope
  throws; `collectSnapshot` returns only touched stores.
- `runtime/store/serialize.test.ts` — `toScriptJson` escapes `</script>`, `<!--`,
  ` `; `parseStoreScript` round-trips; a `</script>`-bearing string value
  cannot break out (assert the serialized text contains no literal `</script>`).
- `runtime/store/react.test.ts` (happy-dom) — `useStore` re-renders a React
  component on store change; SSR snapshot == client snapshot (no mismatch).

Integration (`tests/` — boots the server; rebuild addon first per repo rule):

- `tests/store-isomorphic.test.ts` — a route whose loader seeds a store →
  response HTML contains `<script data-brust-store="…">` with the seeded state;
  two requests with different seeds get different `<script>` payloads (S6); a
  React island on the page reads the seeded value on first paint (no fetch).

## Acceptance criteria

- `bun run ci` (biome) clean.
- New unit suites green; existing `runtime` suite (baseline **297**) still green.
- `cargo test` baselines unchanged (jsx-rust-compiler **221**, brust lib **136**) —
  Spec A touches **no Rust**.
- Integration baseline (**75**) green + the new `store-isomorphic` test.
- `brustjs/store` importable; `import { useStore } from 'brustjs'` type-checks
  against a React island.
- S4 demonstrated in a test: two bundles, one window singleton, cross-sync.
- S6 demonstrated in a test: two request scopes isolated.

## Known limitations (shipped intentionally)

- Native pages gain the snapshot `<script>` + ctx key but remain non-interactive
  until Spec B wires a client to it.
- `effect` is client-meaningful only; server runs it once and discards.
- No nested/derived-store composition, no async actions framework — actions are
  plain functions that call setters.
- Snapshot is whole-state per touched store (no partial/delta) — fine for the
  team/cart/selection scale these stores target.
- pokedex still uses `team-bus.ts`; migration is deferred to Spec B.

## Open questions resolved at plan-time

1. **Native initial-load injection (FAST LANE):** the native initial path returns a
   *length* from `napiRenderJinja` (body stays Rust-side, never returns to JS), so JS
   cannot append a trailer to that body. **Resolution:** for the native initial path,
   Spec A emits the store `<script>` by adding a framework-reserved context key
   `__brustStoreScript` (the pre-escaped `<script>…</script>` string) to the jinja
   `ctx`, and the **base document template** the framework controls renders
   `{{ __brustStoreScript | safe }}` just before `</body>`. If the native base
   template is not framework-owned in a way that allows this without a compiler
   change, the fallback is: have `napiRenderJinja` return the body to JS for the
   initial native path too (mirroring `renderNativeRouteToHtml`) and append in JS —
   accepting the extra copy. **The plan MUST verify which is true by reading the
   native base-document template emission before writing the inject task**, and pick
   the no-Rust-change option if available.
2. **`useStore` param typing:** the handle is `StoreHandle<S> & S`; `useStore`
   accepts that intersection and returns `Snapshot<S>` (a mapped type turning
   `Signal<T>`→`T`, `Computed<T>`→`T`, dropping functions). Plan defines `Snapshot<S>`.

## BLOCKED fallbacks

- **ALS unavailable/leaky in the worker render path:** if `AsyncLocalStorage`
  context does not survive the React `renderToPipeableStream` boundary or the native
  SAB call, fall back to **explicit context threading**: `runInStoreContext` still
  wraps, but the active map is resolved via a module-scope `let current` set/cleared
  synchronously around the *synchronous* render call, and loaders receive the map via
  a 4th ctx field `stores`. Less ergonomic (loader writes `ctx.stores` not the bare
  import on the server) but unblocks. Decide via `server-context.test.ts` proving
  interleave isolation before wiring routes.ts.
- **Snapshot/hydrate mismatch causing React warnings:** if `useSyncExternalStore`
  server snapshot ≠ client first snapshot, gate `useStore`'s server snapshot to read
  the serialized `<script>` directly during hydration. (Captured as a test.)
