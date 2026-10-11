# M3-F wave 1 — the unified store in v2 ("unified memory")

owner: Detoro (lead, 22499151) · authority: in-loop (human: "ทำไปเลยเอาที่ดีที่สุด กับคนใช้งาน", 2026-10-11) · status: APPROVED by lead ruling, implementation plan follows · base: v2 @04794ae

## 0. Why and what

The 0.1.x pitch is one store that server templates, React islands and native components address
directly. v2 has signals inside `@brust/runtime-dom` and nothing else: no `defineStore`, no
`useStore`, no server snapshot, and the native and island bundles are separate builds, so even a
plain module-level signal would exist twice on one page. The human gate: **no v2 beta until the
unified store is back, and better than 0.1.x where v2's architecture allows it** (native
components read the store at render time with a server-seeded first paint).

Sources: the 0.1.x contract (`runtime/store/*`, `runtime/render/inject-store.ts`,
`example/docs/content/store.md`, the Home demo), and the v2 seams
(`packages/runtime-dom/src/signal.ts`, `packages/brust/src/worker.ts`, `crates/brust-server/src/
{pipeline.rs,render.rs}`, `crates/brust-compiler/src/analyze/{hooks.rs,passes/{tier,placement}.rs}`,
`lower/{client,template}.rs`, `packages/brust/src/build/bundle.ts`).

## 1. Decisions (recorded; do not re-open without a lead ruling)

| # | Decision | Why |
|---|---|---|
| D1 | **API surface = `brustjs/store` of 0.1.x, verbatim.** `@brust/core/store` exports `signal, computed, effect, batch, untracked, isSignal, isComputed, defineStore` and the types `Signal, Computed, Dispose, StoreHandle, Snapshot`. `@brust/core/store/react` exports `useStore`. Handle semantics as 0.1.x (proxy; reserved `name subscribe snapshot serialize hydrate then`; `snapshot()` = signals + computeds, referentially stable until a write; `serialize()` = top-level signal values only; `hydrate()` sets signals, ignores unknown keys; first factory wins per name). | Migration from 0.1.x is copy-paste; the store docs page ports unchanged. |
| D2 | **One reactive core.** The store is built on `packages/runtime-dom/src/signal.ts` (not a port of 0.1.x `signal.ts`). The core moves its tracking state (`currentSub`, `batchDepth`, `pending`) to `globalThis[Symbol.for('brust.reactive.ctx')]` and brands signals/computeds with `Symbol.for('brust.signal')` / `Symbol.for('brust.computed')`. | Two copies of a module must behave as one graph (0.1.x lesson); v2 already has the core the directives use. |
| D3 | **One runtime instance per page, by construction.** The island build (`buildReactChunks`) marks `/_brust/*` external and resolves `@brust/runtime-dom`, `@brust/core/store` and `@brust/core/store/react` to the runtime bundle URL, exactly as native chunks do. The runtime bundle re-exports the store API. The store registry `globalThis[Symbol.for('brust.stores')]` (keyed by name) is the second line of defence. | Shared module identity beats a registry-only fix: `effect` tracking across chunks needs one core. |
| D4 | **The server runs store code, per request.** The Bun worker wraps each page's loader chain in `runInStoreContext` (AsyncLocalStorage). Stores touched by loaders AND every store a page's components read at render (manifest `stores`, D7) are serialized after the chain: `LoaderResponse.store: Record<name, Record<key, Json>> \| null`. | 0.1.x parity (`cart.count.set()` works in a loader) plus the guarantee that a native first paint always has a value for what it reads. |
| D5 | **The snapshot is context.** The Rust pipeline stores the snapshot under the reserved ctx key **`__store`** (added to `is_server_slot`; a loader key `__store` is dropped with the existing warning). It is cached in L1 with the rest of the context, exactly like every loader value. | One data path; templates read `__store.<name>.<key>` like any ctx path; no second cache. Caching rule unchanged: L1 is opt-in per route, and caching a per-user page is the same developer error with or without stores (documented). |
| D6 | **Delivery = `<script type="application/json" data-brust-store="<name>">` per store, in the body before the runtime tag**, emitted by `render.rs::inject_assets_into` from `__store`; JSON escaped as 0.1.x (`< > & U+2028 U+2029` → `\uXXXX`, name restricted to `[A-Za-z0-9_.:-]`). Client seeding is lazy on first access to a name (`parseStoreScript` → `hydrate`). | Same tag shape as 0.1.x (tests port); before-runtime placement makes the snapshot available before `mount()` and before any island hydrates (both run after that tag), and the HTML stays L1-cacheable as one string. v2 has no `<head>` injection point and does not need one. |
| D7 | **`useStore(handle)` is a native-tier intrinsic.** In a native component, `const s = useStore(cart)` makes `s` a store view: a render-time read `s.count` is the server path `__store.<name>.count` (template subset, escaped like any dynamic output) and a client signal read `cart.count()` (so bindings update live). Derived values over store reads are precompute slots whose `inputs` include the `__store.<name>.<key>` paths (job key covers them). `<name>` is the string literal of `defineStore('<name>', …)` found by resolving the handle's import to its module (relative imports and `@brust/*` re-exports). If the name cannot be resolved statically, the component falls back to tier `react` with a diagnostic `store-name-unresolved` (graceful fallback, as for every unsupported shape). Writes (`cart.count.set(...)`) and reads in handlers/effects are plain calls, as 0.1.x. The compiler records the store modules a component reads into the manifest (`components[id].stores: string[]`, project-relative module paths) so the worker can touch them per request (D4). | Better than 0.1.x (no placeholders that must match defaults) and it is how a React developer writes it. Cache keys stay correct because store paths are declared inputs. |
| D8 | **React islands.** `useStore` = `useSyncExternalStore(subscribe, snapshot, serverSnapshot)` with the 0.1.x semantics (no selectors; re-render on any write to the store; `{}` when server-rendered outside a scope). SSR jobs run inside a store scope **hydrated from `__store`**, and `__store` is a declared input of every ssr job (`"*"` props + `__store`), so a cached SSR body matches the snapshot it was rendered with. Precompute jobs never see stores (they are pure; render-time store reads become template paths, not precompute). | SSR output == first client snapshot; job cache key stays honest; one rule for all ssr jobs instead of transitive import analysis. |
| D9 | **Out of scope (this wave):** SPA navigation snapshot application (v2 has no SPA navigation yet — the client registry persists across full loads only), selectors, nested signals, Map/Set/Date revival, dev-reload persistence, F76 linked-child rows (own spec). | YAGNI; each is a later wave on top of the same substrate. |
| D10 | **Dogfood = the pokedex regains the stores it dropped in M2** (`team` store: `AddToTeamButton` native + `TeamBuilder` island) **plus a `/unified` page** mirroring the 0.1.x Home demo (island counter + native counter + native read-only node on one store, first paint seeded). The 0.1.x store test suite (§6) ports to v2. | The acceptance is the pitch, running. |

Rejected: **store as props** (snapshot duplicated per host `x-props`; no value before mount; breaks "one substrate"); **client-only + explicit loader seed** (server API not 0.1.x; rejected by the human); **registry-only singleton without a shared core** (cross-chunk `effect` tracking fails — 0.1.x hit this).

## 2. Architecture

```
loader chain (Bun worker, per request)                 Rust pipeline                 browser
┌──────────────────────────────┐   LoaderResponse       ┌──────────────────────┐    ┌──────────────────────────┐
│ runInStoreContext(() => {    │   { data, store }      │ merge data → ctx     │    │ <script data-brust-store>│
│   touch manifest stores      │ ─────────────────────▶ │ ctx.__store = store  │    │ runtime (core+store)     │
│   run loaders (may read/     │                        │ L1 (opt-in) caches   │    │ native chunks ─┐ one     │
│   write stores)              │                        │ ctx incl. __store    │    │ island chunks ─┘ instance│
│   collectSnapshot()          │                        │ ssr jobs: inputs     │    │ registry[name] lazy seed │
│ })                           │                        │   "*" + __store      │    │ useStore / signal reads  │
└──────────────────────────────┘                        │ render: {{ __store.  │    └──────────────────────────┘
                                                        │   cart.count | e }}  │
                                                        │ inject <script …>    │
                                                        └──────────────────────┘
```

### 2.1 Packages and modules (lane: store-core)

- `packages/runtime-dom/src/signal.ts`: tracking state on `globalThis[Symbol.for('brust.reactive.ctx')]`; brands; export `isSignal`, `isComputed`, `untracked` (exists). Behaviour otherwise unchanged (sync flush, `Object.is` guard).
- `packages/runtime-dom/src/store/define-store.ts`, `serialize.ts`, `registry.ts` (browser registry on `globalThis[Symbol.for('brust.stores')]`; `__setServerResolver` hook; `applyStoreSnapshot` reserved for the SPA wave), `react.ts` (`useStore`; React is a peer import only here).
- `packages/runtime-dom/src/index.ts` re-exports the store API (not `useStore`); `packages/runtime-dom/package.json` adds `"./store"`, `"./store/react"` and `"./store/internal"` (the `__setServerResolver` / `hydrateRecord` hook the server lane imports) subpaths. The minified runtime bundle grows from 13.9 KB to ~16.4 KB; the `test/build.test.ts` cap moves from 14 KB to 17 KB (ruling R1).
- `packages/brust/package.json` exports `"./store"` → `@brust/runtime-dom/store` re-export, `"./store/react"` → `@brust/runtime-dom/store/react`. (`@brust/core/store` is the documented import.)
- `packages/brust/src/store/server-context.ts`: `runInStoreContext`, `getServerInstance`, `collectSnapshot`, `touchStores(modules)`; registers the resolver at worker boot (`worker.ts`), never imported by client code.

### 2.2 Worker and server (lane: server)

- `worker.ts` loader path: `runInStoreContext(async () => { await touchStores(manifest.routeStores(route)); run chain; return { data, store: collectSnapshot() } })`. `LoaderResponse.store` is `null` when nothing was touched. Jobs: `runJob('ssr', inputs)` runs inside `runInStoreContext` seeded from `inputs.__store` (hydrate each named store before `renderToString`).
- `crates/brust-server/src/pipeline.rs`: `is_server_slot("__store")`; after `merge_loader_data`, insert `__store` (object or omitted when null); ssr job inputs get `__store` (the whole snapshot object; `inputs::job_key` hashes it as any input). `plan_in_call`/planned loader path: `store` rides in the same envelope as `data` (protocol field added to `LoaderResponse` on both sides; see `protocol.rs`).
- `crates/brust-server/src/render.rs::inject_assets_into`: before the runtime tag, one `<script type="application/json" data-brust-store="NAME">JSON</script>` per store in `__store` (sorted by name for byte-stable snapshots). Nothing when `__store` is absent.
- `packages/brust/src/build/bundle.ts`: islands build gets `external: ['/_brust/*']` and the same runtime alias map as the client-chunks build; the runtime entry re-exports the store API (`export * from '@brust/runtime-dom'` already covers it once runtime-dom re-exports). `bundle.ts:103` server-only regex renamed to `@brust/core/(server|native)` (latent bug found during exploration; in boundary, fix it).
- Manifest: `components[id].stores: string[]` (from the compiler), `routes[i]` derive the union over the chain for `touchStores`.

### 2.3 Compiler (lane: compiler)

- `analyze/hooks.rs`: `useStore` imported from `@brust/core/store/react` (or `brust/store/react`, the bare form the tests use) is a recognised native-tier hook with arity 1 whose argument must be an imported identifier (or `pkg.member`) resolving to `defineStore('<lit>', …)`; otherwise fallback `store-name-unresolved` → tier react.
- Store-view roots: the binding of `useStore(h)` is a **server-subset root** named `__store.<name>`: `s.count` → server path `__store.<name>.count`; in the client chunk, `s.count` → `<h>.count()` where `<h>` is the imported handle (the chunk imports the store module, as it would any client-safe module). Optional chains follow the existing rules.
- Placement: derived values whose inputs include store paths are precompute slots with those paths in `inputs` (`placement.rs:395-431` already treats prop paths this way; store paths join the same set). `state_dependent` stays false for the server, but the client emits a `computed` over the signal reads (so the derived value updates live) — reuse the existing "derived from props" client emission.
- Manifest: `stores` per component (project-relative module path of every resolved store module).
- Diagnostics (golden): `store-name-unresolved`, `store-write-in-render` (a `.set` call reachable from render → tier react, same class as other side effects).
- `dual_eval`/battery: new fixtures `store-read`, `store-derived`, `store-handler-write`, `store-unresolved-fallback`; rendered HTML equal between jinja and JS with a seeded `__store`.

### 2.4 Hydration order (no change needed, stated for the record)

`inject_assets_into` order: `[store scripts] → runtime tag (mount(); scheduleIslands) → native chunks → islands`. Native `mount()` runs after the store scripts exist in the DOM; islands hydrate on idle and import the store through the runtime URL (D3), so the first `useStore` seeds from the tag. Island props stay JSON (`x-props`); live store values reach an island only through `useStore`.

## 3. Interface contracts between lanes (fixed here; changing one is a lead ruling)

| Contract | Value |
|---|---|
| C1 ctx key | `__store` : `{ [storeName]: { [signalKey]: Json } }` ; absent when no store was touched |
| C2 `LoaderResponse` | `{ data: Record<string, Json>, store: C1-object \| null }` (TS `worker.ts`, Rust `protocol.rs` + napi) |
| C3 manifest | `components[id].stores: string[]` (project-relative paths, sorted, unique); worker derives the per-route union |
| C4 script tag | `<script type="application/json" data-brust-store="NAME">ESCAPED_JSON</script>`, one per store, sorted by name, placed immediately before the runtime `<script>` |
| C5 ssr job inputs | existing `"*"` props object gains the key `__store` (C1 object or `null`); `inputs::job_key` hashes it like every input |
| C6 module specifiers | `@brust/core/store`, `@brust/core/store/react` (and `brust/store`, `brust/store/react` in compiler tests); compiled chunks import the store module by its project path; island + native builds resolve `@brust/runtime-dom`, `@brust/runtime-dom/store`, `@brust/core/store` to the runtime URL (external `/_brust/*`). **`@brust/core/store/react` (= `@brust/runtime-dom/store/react`) is NOT in the runtime bundle** — the runtime stays React-free (`scripts/build.ts`), so `useStore` is bundled into the islands build; its file has type-only imports toward the core, so it adds no second core (lead ruling R2 on the core plan, 2026-10-11). The server lane's `bundle.ts` encodes this split. |
| C7 globals | `globalThis[Symbol.for('brust.reactive.ctx')]`, `globalThis[Symbol.for('brust.stores')]`, brands `Symbol.for('brust.signal')` / `Symbol.for('brust.computed')` |
| C8 reserved handle members | `name subscribe snapshot serialize hydrate then` |

## 4. Error handling and limits

- Server store access outside a request scope throws the 0.1.x strings verbatim: the resolver throws `store '<name>' accessed outside a request scope`, and a server access with no resolver installed throws `store '<name>' accessed on the server without a request scope` (ruling R3). `useStore` returns `{}` during SSR outside a scope. Resolution order (ruling R4): an installed server resolver takes EVERY access; otherwise the browser registry when `document` exists; otherwise throw — a polyfilled `window` in the worker can never leak a request's store into the page-global registry.
- `BigInt` / functions / `undefined` in a signal value: `serialize()` drops functions and `undefined`; `BigInt` throws at serialization with the store and key named. `Map`/`Set` serialize to `{}` (documented, D9).
- A loader returning the key `__store` is dropped with the existing "collides with a server slot" warning.
- Two `defineStore` calls with the same name and different factories: first wins (0.1.x); the compiler warns `store-name-duplicate` when it sees two literals with one name in one build.
- Snapshot size is unbounded, as 0.1.x; the docs page says what goes in a store.

## 5. Acceptance (milestone gate)

1. The ported 0.1.x test suite (§6) is green in `packages/runtime-dom` and `packages/brust`.
2. Compiler: new fixtures green, `dual_eval` unchanged for existing fixtures and equal for the store fixtures, battery rows added (`store-*`), goldens reviewed.
3. Server: `tests/server/` e2e — a page whose loader writes `cart.count = 3` renders `3` in a native component's first paint and in an SSR island; the `data-brust-store` tag is present once per store; an L1 HIT serves the same tag; a page with no stores emits no tag.
4. Chromium (`hydrate.chromium.test.ts`): on `/unified`, clicking the native button updates the island text and the read-only node without a reload; clicking the island button updates the native text; first paint text equals the seeded value (no flash of default).
5. Perf: `bun run bench` S/D/I within −1% of `bench/RESULTS.md` @04794ae (interleaved A/B, 3 rounds; D/I/S pages touch no store, so the cost must be ~0).
6. Docs: `docs/store.md` (port of `example/docs/content/store.md` with v2 import paths and the native render-time read).

## 6. Tests to port (names are the contract; see 0.1.x `runtime/store/*.test.ts`, `render/inject-store.test.ts`)

signal: initial/set/set(fn); Object.is guard; computed memoizes and recomputes; effect runs once immediately, re-runs, stops after dispose; batch coalesces; effect reading and conditionally writing the same signal does not overflow; cleanup runs before re-run and once on dispose; cleanup runs untracked; dispose during cleanup write does not re-run body; dispose twice runs cleanup once; brands via Symbol.for across two module instances.
define-store: proxy reads active instance; serialize = signals only; hydrate → snapshot → computed evaluated; snapshot referentially stable; subscribe fires on write; no-op set is silent; RESERVED blocks `then`.
registry: two handles share one instance; first access hydrates from the script tag.
server-context: fresh map per scope; outside scope throws; collectSnapshot touched-only, null when none; interleave isolation.
serialize: round-trip; no literal `</script>`; `<!--`, `&`, U+2028/9 escaped; tag shape; parse; bad JSON → `{}`.
react: useStore renders snapshot and reflects writes; server snapshot matches.
inject: null/empty unchanged; one tag per store; placement before the runtime tag (v2 variant of the `</head>` tests).

## 7. Lanes (plan follows in `docs/plans/2026-10-11-m3f-unified-store-*.md`)

| lane | scope | tier / review | deps |
|---|---|---|---|
| `m3f-store-core` | §2.1 (runtime-dom core + store modules + react bridge + package exports) + §6 unit tests | standard / complex | — |
| `m3f-store-server` | §2.2 (worker scope, protocol field, pipeline `__store`, render injection, bundle externals/aliases, manifest union) + server tests | complex / complex | C1–C7 only (parallel with core; integrates on merge) |
| `m3f-store-compiler` | §2.3 (intrinsic, store-view roots, placement inputs, manifest `stores`, ssr `__store` input, diagnostics, fixtures, battery) | complex / complex | C3, C5, C6 only |
| `m3f-store-dogfood` | §1 D10 + §5 items 3–6 (pokedex team store, `/unified` page, e2e, Chromium, bench check, docs) | standard / complex | all three merged |

Global constraints every lane inherits: integration branch **`m3f`** (from v2 @04794ae, worktree `~/code/brust-m3f`); lanes branch from `m3f` (`git worktree add ../brust-lane-<slug> -b lane/<slug> m3f`), the lead merges each lane into `m3f` after review + gates (no per-lane PR, as M3-P), and ONE PR `m3f → v2` runs CI at the end — v2 never holds a half-wired store (a compiler that reads `__store` before the server fills it would render empty values). Byte-identical snapshots for every route that touches no store, and every contract in §3 is used verbatim — a lane that needs a different value files a `task challenge`.
