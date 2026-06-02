# Implementation plan — Spec A: Isomorphic store core

Spec: `docs/superpowers/specs/2026-06-02-isomorphic-store-core-design.md`
Branch: `feat/isomorphic-store-core`

**Repo rules baked into every task:**
- Lint gate is **biome** — run `bun run ci` from repo root (NOT `tsc`, which
  stack-overflows here). Never `git add -A` (sweeps untracked `tools/`).
- After ANY change that an integration test boots the server with, the addon is
  already built (Spec A is 0-Rust, so the committed `.node` stays valid) — but T8
  boots the server, so confirm the addon exists (`runtime/*.node`); rebuild only if
  missing (`cd runtime && bun run build:debug`).
- Tests use `bun test`. happy-dom is a devDep; use `// @happy-dom` setup via
  `/** @jsxImportSource */`? No — these are not JSX-DOM tests; use
  `import { Window } from 'happy-dom'` or Bun's `happydom` preload. Follow the
  existing pattern in `runtime/islands/bootstrap.test.ts` (it already drives DOM).

**TDD for every task:** write the test file first, watch it fail (red), implement to
green, refactor. Paste the failing-test output in the report.

## Spec coverage table

| Spec section | Task |
|---|---|
| Reactivity core (signal/computed/effect/batch) | T1 |
| Serialization + XSS safety | T2 |
| `defineStore`, client singleton (S4), proxy, snapshot/serialize/hydrate | T3 |
| Server per-request scope (S6), `runInStoreContext`, `collectSnapshot` | T4 |
| `brustjs/store` barrel + `./store` export + `useStore` + `brustjs` export | T5 |
| `injectBrustStore` | T6 |
| Render wiring (stream.ts buffering+streaming, routes.ts ALS+nav, bootstrap.ts) | T7 |
| Integration (React-path seed → `<script>`, S6 two-seed) | T8 |

Dependency order: T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 (strict sequence).

---

## T1 — Reactivity core (`runtime/store/signal.ts`)

**Test first:** `runtime/store/signal.test.ts`
- signal read returns initial; `.set(v)` updates; `.set(fn)` updates from prev.
- `Object.is` guard: `.set` to equal value does NOT notify (track notify count via an effect).
- `computed` memoizes (fn called once for repeated reads with no dep change); recomputes after a dep `.set`.
- `effect` runs once immediately, re-runs on tracked dep change, stops after `dispose()`.
- `batch`: two `.set` inside one `batch` → effect re-runs once, not twice.
- brands: `isSignal(signal(1))` true, `isSignal(computed(()=>1))` false, `isComputed` mirror.

**Implement:**

```ts
// runtime/store/signal.ts
// Minimal pull-based reactive core: push-on-write, pull-on-read, synchronous notify.
// Framework-agnostic — no react, no dom. Foundation for defineStore (Spec A) and
// the Alpine-style client runtime (Spec B).

const SIGNAL = Symbol('brust.signal')
const COMPUTED = Symbol('brust.computed')

export interface Signal<T> {
  (): T
  set(next: T | ((prev: T) => T)): void
  readonly [SIGNAL]: true
}
export interface Computed<T> {
  (): T
  readonly [COMPUTED]: true
}

export function isSignal(v: unknown): v is Signal<unknown> {
  return typeof v === 'function' && (v as { [SIGNAL]?: true })[SIGNAL] === true
}
export function isComputed(v: unknown): v is Computed<unknown> {
  return typeof v === 'function' && (v as { [COMPUTED]?: true })[COMPUTED] === true
}

// A reactive consumer (effect or computed) tracking its dependencies.
interface Consumer {
  run(): void
  deps: Set<Set<Consumer>>
}

let activeConsumer: Consumer | null = null
let batchDepth = 0
const pendingNotify = new Set<Consumer>()

function track(subscribers: Set<Consumer>): void {
  if (activeConsumer) {
    subscribers.add(activeConsumer)
    activeConsumer.deps.add(subscribers)
  }
}

function notify(subscribers: Set<Consumer>): void {
  // Snapshot — a consumer re-running mutates the set.
  for (const c of [...subscribers]) {
    if (batchDepth > 0) pendingNotify.add(c)
    else c.run()
  }
}

function flush(): void {
  const queued = [...pendingNotify]
  pendingNotify.clear()
  for (const c of queued) c.run()
}

export function batch(fn: () => void): void {
  batchDepth++
  try {
    fn()
  } finally {
    batchDepth--
    if (batchDepth === 0) flush()
  }
}

export function signal<T>(initial: T): Signal<T> {
  let value = initial
  const subscribers = new Set<Consumer>()
  const read = (() => {
    track(subscribers)
    return value
  }) as Signal<T>
  read.set = (next: T | ((prev: T) => T)) => {
    const v = typeof next === 'function' ? (next as (p: T) => T)(value) : next
    if (Object.is(v, value)) return
    value = v
    notify(subscribers)
  }
  Object.defineProperty(read, SIGNAL, { value: true })
  return read
}

function clearDeps(c: Consumer): void {
  for (const dep of c.deps) dep.delete(c)
  c.deps.clear()
}

export function computed<T>(fn: () => T): Computed<T> {
  let cached: T
  let dirty = true
  const subscribers = new Set<Consumer>()
  const self: Consumer = {
    deps: new Set(),
    run() {
      dirty = true
      notify(subscribers) // downstream recomputes lazily on next read
    },
  }
  const read = (() => {
    track(subscribers)
    if (dirty) {
      clearDeps(self)
      const prev = activeConsumer
      activeConsumer = self
      try {
        cached = fn()
        dirty = false
      } finally {
        activeConsumer = prev
      }
    }
    return cached
  }) as Computed<T>
  Object.defineProperty(read, COMPUTED, { value: true })
  return read
}

export function effect(fn: () => void): () => void {
  const self: Consumer = {
    deps: new Set(),
    run() {
      clearDeps(self)
      const prev = activeConsumer
      activeConsumer = self
      try {
        fn()
      } finally {
        activeConsumer = prev
      }
    },
  }
  self.run()
  return () => clearDeps(self)
}
```

**Verify:** `bun test runtime/store/signal.test.ts` → all green. `bun run ci` clean.

---

## T2 — Serialization + XSS (`runtime/store/serialize.ts`)

**Test first:** `runtime/store/serialize.test.ts`
- `toScriptJson({a:1})` round-trips via `JSON.parse`.
- A string value containing `</script>` → output contains NO literal `</script>`
  (assert `out.includes('</script>')` is false; `out.includes('\\u003c/script>')` or
  the escaped form true).
- `<!--`, `&`, ` `, ` ` are escaped.
- `storeScriptTag('team', {x:1})` returns
  `<script type="application/json" data-brust-store="team">…</script>`.
- `parseStoreScript(el)` reads `JSON.parse(el.textContent)`.

**Implement:**

```ts
// runtime/store/serialize.ts
// JSON for embedding in a <script> TEXT node (not an attribute). brust runs
// AutoEscape::None and a request-derived value can reach a serialized signal, so
// escape against </script> / <!-- breakout. See memory brust-jinja-autoescape-none.

const ESC: Record<string, string> = {
  '<': '\\u003c',
  '>': '\\u003e',
  '&': '\\u0026',
  ' ': '\\u2028',
  ' ': '\\u2029',
}

export function toScriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&  ]/g, (c) => ESC[c])
}

export function storeScriptTag(name: string, state: unknown): string {
  // name comes from defineStore (developer literal), not request data; still
  // guard the attribute against quote breakout by rejecting unexpected chars.
  const safeName = String(name).replace(/[^a-zA-Z0-9_.:-]/g, '')
  return `<script type="application/json" data-brust-store="${safeName}">${toScriptJson(state)}</script>`
}

export function parseStoreScript(el: { textContent: string | null }): Record<string, unknown> {
  const text = el.textContent ?? '{}'
  return JSON.parse(text) as Record<string, unknown>
}
```

> Note: `\\u003c` in source is the two-char sequence `<` in the emitted string,
> which the browser JSON parser reads as `<`. The raw bytes in the HTML contain no
> `<`, so no tag can close. Test asserts on the emitted string, not the parsed value.

**Verify:** `bun test runtime/store/serialize.test.ts` green; `bun run ci` clean.

---

## T3 — `defineStore` + client singleton (`runtime/store/define-store.ts`)

**Test first:** `runtime/store/define-store.test.ts` + `runtime/store/client-singleton.test.ts` (happy-dom).
- Proxy: `team.members` reads the active instance's signal handle; `team.add(x)` calls it.
- `serialize()` includes signal keys with their VALUES, excludes computed + functions.
- `hydrate({members:[…]})` sets the signal; `snapshot().members` reflects it; computed
  in snapshot is the evaluated value; snapshot is referentially stable until a change.
- (happy-dom) two distinct `defineStore('x', f)` handles → same `window.__BRUST_STORES__.x`;
  `subscribe` on handle A fires when handle B writes.
- (happy-dom) first client access hydrates from `<script data-brust-store="x">{…}</script>`
  injected into `document` before access.

**Implement:**

```ts
// runtime/store/define-store.ts
import { type Signal, type Computed, isSignal, isComputed } from './signal.ts'
import { parseStoreScript } from './serialize.ts'
import { getServerInstance } from './server-context.ts'

export type Snapshot<S> = {
  [K in keyof S as S[K] extends (...a: never[]) => unknown
    ? S[K] extends Signal<unknown> | Computed<unknown>
      ? K
      : never
    : K]: S[K] extends Signal<infer T> ? T : S[K] extends Computed<infer T> ? T : S[K]
}

const RESERVED = new Set(['name', 'subscribe', 'snapshot', 'serialize', 'hydrate'])

export interface StoreHandle<S extends object> {
  (): S
  readonly name: string
  subscribe(cb: () => void): () => void
  snapshot(): Snapshot<S>
  serialize(): Record<string, unknown>
  hydrate(state: Record<string, unknown>): void
}

interface ClientRegistry {
  [name: string]: { instance: object; subs: Set<() => void> }
}
function clientRegistry(): ClientRegistry {
  const w = window as unknown as { __BRUST_STORES__?: ClientRegistry }
  if (!w.__BRUST_STORES__) w.__BRUST_STORES__ = {}
  return w.__BRUST_STORES__
}

// We need each instance's signals to notify the store's subscriber set on write.
// signal.ts subscribers are internal; to bridge to React's subscribe, defineStore
// wraps the instance: after factory(), for every signal property we wrap .set to
// also fire the store-level subscriber set. (computed downstream of those signals
// is recomputed lazily; React re-reads snapshot which evaluates it.)
function bridgeSubscribers(instance: Record<string, unknown>, subs: Set<() => void>): void {
  for (const key of Object.keys(instance)) {
    const v = instance[key]
    if (isSignal(v)) {
      const sig = v as Signal<unknown>
      const origSet = sig.set.bind(sig)
      sig.set = (next) => {
        origSet(next as never)
        for (const cb of [...subs]) cb()
      }
    }
  }
}

export function defineStore<S extends object>(
  name: string,
  factory: () => S,
): StoreHandle<S> & S {
  const subsFor = (instance: object): Set<() => void> => {
    if (typeof window !== 'undefined') return clientRegistry()[name].subs
    return getServerInstance(name).subs
  }

  function resolve(): { instance: S; subs: Set<() => void> } {
    if (typeof window !== 'undefined') {
      const reg = clientRegistry()
      if (!reg[name]) {
        const instance = factory() as object
        const subs = new Set<() => void>()
        bridgeSubscribers(instance as Record<string, unknown>, subs)
        reg[name] = { instance, subs }
        // hydrate from server-injected <script> if present
        const el = document.querySelector(`script[data-brust-store="${name}"]`)
        if (el) handle.hydrate(parseStoreScript(el))
      }
      return { instance: reg[name].instance as S, subs: reg[name].subs }
    }
    // server: per-request via AsyncLocalStorage
    const rec = getServerInstance(name, () => {
      const instance = factory() as object
      const subs = new Set<() => void>()
      bridgeSubscribers(instance as Record<string, unknown>, subs)
      return { instance, subs, handle: handle as StoreHandle<object> }
    })
    return { instance: rec.instance as S, subs: rec.subs }
  }

  const handle = (() => resolve().instance) as StoreHandle<S> & S
  Object.defineProperty(handle, 'name', { value: name })
  handle.subscribe = (cb) => {
    const { subs } = resolve()
    subs.add(cb)
    return () => subs.delete(cb)
  }
  handle.snapshot = () => {
    const { instance } = resolve()
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(instance as object)) {
      const v = (instance as Record<string, unknown>)[key]
      if (isSignal(v) || isComputed(v)) out[key] = (v as () => unknown)()
    }
    return out as Snapshot<S>
  }
  handle.serialize = () => {
    const { instance } = resolve()
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(instance as object)) {
      const v = (instance as Record<string, unknown>)[key]
      if (isSignal(v)) out[key] = (v as () => unknown)()
    }
    return out
  }
  handle.hydrate = (state) => {
    const { instance } = resolve()
    for (const key of Object.keys(state)) {
      const v = (instance as Record<string, unknown>)[key]
      if (isSignal(v)) (v as Signal<unknown>).set(state[key])
    }
  }

  return new Proxy(handle, {
    get(target, prop, recv) {
      if (typeof prop === 'symbol' || RESERVED.has(prop) || prop === 'name') {
        return Reflect.get(target, prop, recv)
      }
      const { instance } = resolve()
      return (instance as Record<string | symbol, unknown>)[prop]
    },
  })
}
```

> `handle.snapshot` must be **referentially stable until a change** for
> `useSyncExternalStore`. The above rebuilds the object each call → React would loop.
> **Fix in this task:** memoize snapshot — cache the object and a version counter
> bumped by the bridged `.set`; return the cached object until version changes. The
> implementer MUST add this memo (test: two `snapshot()` calls with no write are
> `===`). Pattern: store `{ snap, version }` per instance; bridge increments version;
> snapshot rebuilds only when `version` advanced.

**Verify:** both test files green; `bun run ci` clean.

---

## T4 — Server per-request scope (`runtime/store/server-context.ts`) — ALS GATE

**Test first:** `runtime/store/server-context.test.ts`
- `runInStoreContext` runs fn with a fresh Map; `getServerInstance` creates once per
  scope via the factory.
- **Interleave isolation:** start two `runInStoreContext` scopes that each `await` a
  Promise between two `getServerInstance(...).instance` mutations; assert each scope's
  final value is its own (no cross-contamination). This is the S6 proof and the ALS
  gate — if it fails, take the BLOCKED fallback (module-scope `let current`).
- `getServerInstance` outside any scope **throws** `outside a request scope`.
- `collectSnapshot()` returns `{name: serialized}` for touched stores; `null` if none.

**Implement:**

```ts
// runtime/store/server-context.ts
import { AsyncLocalStorage } from 'node:async_hooks'

export interface StoreRecord {
  instance: object
  subs: Set<() => void>
  handle: { serialize(): Record<string, unknown> }
}

const storeContext = new AsyncLocalStorage<Map<string, StoreRecord>>()

export function runInStoreContext<T>(fn: () => T): T {
  return storeContext.run(new Map(), fn)
}

// Client builds its own registry; on the server this resolves the per-request map.
// `create` is required when first-accessing in a scope; reads pass it too (idempotent).
export function getServerInstance(
  name: string,
  create?: () => StoreRecord,
): StoreRecord {
  const map = storeContext.getStore()
  if (!map) {
    throw new Error(`store '${name}' accessed outside a request scope`)
  }
  let rec = map.get(name)
  if (!rec) {
    if (!create) throw new Error(`store '${name}' not initialized in this scope`)
    rec = create()
    map.set(name, rec)
  }
  return rec
}

export function collectSnapshot(): Record<string, Record<string, unknown>> | null {
  const map = storeContext.getStore()
  if (!map || map.size === 0) return null
  const out: Record<string, Record<string, unknown>> = {}
  for (const [name, rec] of map) out[name] = rec.handle.serialize()
  return out
}
```

> `define-store.ts` (T3) imports `getServerInstance` from here — the `create` thunk
> in T3's server branch returns `{ instance, subs, handle }`. Reconcile the two-arg
> shape: T3 calls `getServerInstance(name, () => ({instance, subs, handle}))`. Adjust
> T3's server branch if the signature drifted during T3 (it was written before T4) —
> this task OWNS the final signature; fix T3's call site here and re-run T3's tests.

**Verify:** `server-context.test.ts` green (esp. interleave). Re-run T3 tests green.
`bun run ci` clean. **Report the interleave-test result explicitly — it decides ALS
vs fallback.**

---

## T5 — Barrel + exports + React adapter

**Files:**
- `runtime/store/index.ts` (barrel — `brustjs/store`; **NO react re-export**):
```ts
// runtime/store/index.ts — brustjs/store. Isomorphic, react-free, dom-free.
export { signal, computed, effect, batch, isSignal, isComputed } from './signal.ts'
export type { Signal, Computed } from './signal.ts'
export { defineStore } from './define-store.ts'
export type { StoreHandle, Snapshot } from './define-store.ts'
export { toScriptJson, parseStoreScript, storeScriptTag } from './serialize.ts'
```
- `runtime/store/react.ts`:
```ts
// runtime/store/react.ts — React adapter. Exported from the brustjs MAIN entry,
// never from ./store (which must stay react-free).
import { useSyncExternalStore } from 'react'
import type { StoreHandle, Snapshot } from './define-store.ts'

export function useStore<S extends object>(store: StoreHandle<S> & S): Snapshot<S> {
  return useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot)
}
```
- `runtime/store/client-hydrate.ts`:
```ts
// runtime/store/client-hydrate.ts — apply a nav-payload snapshot to live client stores.
export function applyStoreSnapshot(snap: Record<string, Record<string, unknown>>): void {
  const w = window as unknown as {
    __BRUST_STORES__?: Record<string, { instance: Record<string, unknown> }>
  }
  const reg = w.__BRUST_STORES__
  if (!reg) return
  for (const [name, state] of Object.entries(snap)) {
    const entry = reg[name]
    if (!entry) continue // handle not defined yet on client → skip (initial-load <script> covers it)
    for (const key of Object.keys(state)) {
      const v = entry.instance[key] as { set?: (x: unknown) => void } | undefined
      if (v && typeof v.set === 'function') v.set(state[key])
    }
  }
}
```
- `runtime/index.ts` edit — add after the `BrustPage` export block (~line 748):
```ts
export { useStore } from './store/react.ts'
```
- `package.json` edit — add to `exports`:
```json
    "./store": "./runtime/store/index.ts",
```

**Test:** `runtime/store/react.test.ts` (happy-dom) — render a component using
`useStore(team)`; write to `team` → component re-renders with new value; assert the
server-snapshot path (call `store.snapshot()` directly) equals the value React reads.

**Verify:** `bun test runtime/store/` all green; `bun run ci` clean. Confirm
`bun -e "import('brustjs/store').then(m=>console.log(typeof m.defineStore))"` prints
`function` (resolve check). Confirm `./store` barrel does NOT pull react: grep that
`runtime/store/index.ts` has no `react` import.

---

## T6 — `injectBrustStore` (`runtime/render/inject-store.ts`)

Mirror `inject-action-prefix.ts`. Inject one combined `<script>` blob (all touched
stores) immediately before the first `</head>` (same `findHeadCloseTag` strategy);
return body untouched if snapshot is null/empty.

**Test first:** `runtime/render/inject-store.test.ts`
- null snapshot → body unchanged (same reference acceptable).
- snapshot with one store → output contains `data-brust-store="team"` before `</head>`.
- no `</head>` → body unchanged (warn-once).
- multi-store snapshot → one `<script>` per store, all before `</head>`.

**Implement:**

```ts
// runtime/render/inject-store.ts
import { storeScriptTag } from '../store/serialize.ts'

const ENC = new TextEncoder()
let warned = false
export function _resetWarnedForTests(): void { warned = false }

export function buildStoreScripts(
  snap: Record<string, Record<string, unknown>> | null,
): string {
  if (!snap) return ''
  let out = ''
  for (const [name, state] of Object.entries(snap)) out += storeScriptTag(name, state)
  return out
}

export function injectBrustStore(
  body: Uint8Array,
  snap: Record<string, Record<string, unknown>> | null,
): Uint8Array {
  const scripts = buildStoreScripts(snap)
  if (!scripts) return body
  const pos = findHeadCloseTag(body)
  if (pos < 0) {
    if (!warned) {
      console.warn('[brust] store: no </head> in first chunk; snapshot not injected')
      warned = true
    }
    return body
  }
  const tagBytes = ENC.encode(scripts)
  const out = new Uint8Array(body.length + tagBytes.length)
  out.set(body.subarray(0, pos), 0)
  out.set(tagBytes, pos)
  out.set(body.subarray(pos), pos + tagBytes.length)
  return out
}

function findHeadCloseTag(body: Uint8Array): number {
  const LT = 0x3c, SL = 0x2f, GT = 0x3e
  for (let i = 0, max = body.length - 6; i < max; i++) {
    if (body[i] !== LT || body[i + 1] !== SL) continue
    if (!isLetter(body[i + 2], 0x48)) continue // H
    if (!isLetter(body[i + 3], 0x45)) continue // E
    if (!isLetter(body[i + 4], 0x41)) continue // A
    if (!isLetter(body[i + 5], 0x44)) continue // D
    if (body[i + 6] !== GT) continue
    return i
  }
  return -1
}
function isLetter(b: number, u: number): boolean { return b === u || b === (u | 0x20) }
```

**Verify:** `bun test runtime/render/inject-store.test.ts` green; `bun run ci` clean.

---

## T7 — Render wiring (stream.ts, routes.ts, bootstrap.ts) — INTEGRATION

This is the invasive task. Strict sub-steps; run `bun test runtime/` + boot smoke
after.

**7a — `renderBranchStreaming` takes a `storeSnapshot` arg (`stream.ts`):**
- Add to `RenderBranchStreamingArgs`: `storeSnapshot?: Record<string, Record<string, unknown>> | null`.
- import `injectBrustStore` from `./inject-store.ts`.
- Buffering `_final` (after `injectActionPrefix`, line ~152):
```ts
  body = injectActionPrefix(body, getActionPrefixSnippet())
  body = injectBrustStore(body, args.storeSnapshot ?? null)
```
- Streaming first chunk (line ~213-215): include store scripts in the prepend. Since
  `</head>` is in a later React chunk, append the store `<script>` to the same prepend
  string as the link/dev/prefix tags:
```ts
  const storeTag = buildStoreScripts(args.storeSnapshot ?? null) // import from inject-store.ts
  if (linkTagsStr.length > 0 || devTag.length > 0 || prefixTag.length > 0 || storeTag.length > 0) {
    const prepend = encoder.encode(linkTagsStr + prefixTag + devTag + storeTag)
    …
  }
```

**7b — wrap loader+render in ALS and collect snapshot (`routes.ts`):**
- import `{ runInStoreContext, collectSnapshot }` from `./store/server-context.ts`.
- **React render branch:** locate where `buildRenderElement` is called and
  `renderBranchStreaming` is invoked (~line 766). Wrap the span:
  ```ts
  return runInStoreContext(async () => {
    const element = await buildRenderElement(...)
    const storeSnapshot = collectSnapshot()   // loaders done; stores seeded
    return renderBranchStreaming({ element, ..., storeSnapshot })
  })
  ```
  (Adapt to the existing control flow — the wrap must enclose BOTH the loader run and
  the render so the ALS scope is live for any store read during render; snapshot is
  collected after loaders, which is where Spec A stores are seeded.)
- **React nav branch (`navigationBranch`, ~line 974):** wrap the loader+render span in
  `runInStoreContext`; after building HTML, `const store = collectSnapshot()`; change
  `JSON.stringify({ html: innerHtml, title })` → `JSON.stringify({ html: innerHtml, title, store })`.
- **Native branches (initial ~636, nav ~1012):** wrap the loader call in
  `runInStoreContext` so a native loader's store writes are per-request-safe. **Do NOT
  inject any `<script>`** (Spec B). collectSnapshot not called here.

**7c — `bootstrap.ts navigate()`:**
- import `{ applyStoreSnapshot }` from `../store/client-hydrate.ts`.
- destructure: `const { html, title, store } = (await resp.json()) as { html: string; title: string; store?: Record<string, Record<string, unknown>> }`.
- after `swapMainContent(...)`, before `hydrateMarkersIn(...)`:
  `if (store) applyStoreSnapshot(store)`.

**Verify:**
- `bun test runtime/` → existing suite green (no regressions) + new suites.
- `bun run ci` clean.
- Boot smoke (manual): build + run the pokedex, `curl` a React-path route, confirm no
  crash and (if that route seeds a store) a `data-brust-store` script appears. (Pokedex
  routes are native, so this smoke mainly confirms no regression; the seeded-store
  assertion is T8's fixture.)

> **BLOCKED fallback (from spec):** if T4's interleave test failed → ALS unreliable →
> implement the module-scope `let current` fallback in `server-context.ts` and thread
> the map via a 4th loader ctx field; re-run T4 before T7b.

---

## T8 — Integration (`tests/store-isomorphic.test.ts`)

Add a React-path fixture route whose loader seeds a store, boot the server, assert.

- Use the existing integration harness pattern (`tests/integration.test.ts` /
  `tests/fixtures/app`). Add a route (React, NOT native) with a loader that calls
  `someStore.value.set(<seed-from-query>)` and a component using `useStore`.
- Confirm `runtime/*.node` exists (rebuild if missing — Spec A is 0-Rust so committed
  binary is valid).
- Assertions:
  - GET the route → HTML contains `<script type="application/json" data-brust-store="…">`
    with the seeded value (parse it, assert).
  - GET with two different `?seed=` values → two different script payloads (**S6**:
    no cross-request leakage; the second request doesn't see the first's value).
  - The page needs no second fetch to know the value (the script is in the initial HTML).

**Verify:** `bun test tests/store-isomorphic.test.ts` green; full `bun test tests/`
green; `bun run ci` clean.

---

## Final gate (orchestrator, Phase 6)

- `bun run ci` clean
- `bun test runtime/` + `bun test tests/` green (record counts)
- `cargo test` baselines UNCHANGED (0-Rust) — spot-run jsx-rust-compiler + brust lib
- manual: parse a seeded route's `data-brust-store` payload from a live `curl`
- read the full `git diff base..HEAD` on `routes.ts` + `stream.ts` for scope creep
