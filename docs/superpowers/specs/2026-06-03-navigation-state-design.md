# Navigation state + SPA client route-active — design

**Date:** 2026-06-03 · **Feature:** client-side Navigation state for the brust framework, consumed by SPA route-active highlighting in `example/pokedex/components/AppLayout.tsx`.

## Goal

Give brust a **client-side navigation state** the SPA navigator (`runtime/islands/bootstrap.ts`) drives through its lifecycle, exposed as a new public entry `brustjs/navigation`, and use it to fix a concrete bug in the pokedex example: **the sidebar active-nav highlight does not update on SPA navigation.**

The state tracks:
- **current route** — committed `path` + `search`
- **watch-before-change** — a `phase: 'loading'` window with `from`/`to`, plus an `onBeforeNavigate` hook
- **loading page** — `phase === 'loading'` (and an `html[data-brust-nav="loading"]` attribute for CSS-driven indicators)
- **route success / error** — `phase` transitions to `'success'`/`'error'`, with `onNavigate` / `onNavigateError` hooks

### The concrete bug this fixes

`AppLayout.tsx` renders the sidebar nav (with `is-active`) **outside `<main>`**. `bootstrap.ts:navigate()` swaps only `<main>` (`runtime/islands/bootstrap.ts:223-231`). So after an SPA click from `/` → `/type-chart`, the content swaps but the sidebar still highlights "All Pokémon" until a full reload. A client nav-state + a built-in active-link updater reconciles the sidebar on every SPA navigation.

## Non-goals (loud, out of scope)

- **Navigation guards / cancellation.** `onBeforeNavigate` is **observe-only** — it cannot veto or redirect a navigation. (A guard API is a separate future feature; vetoing risks trapping users on a page.)
- **Link prefetching / preloading.**
- **Scroll restoration** beyond the existing `window.scrollTo(0,0)` in `navigate()`.
- **A bespoke React hook** (`useNavigation`). The store is plain signals + a `subscribe`; React authors use `useSyncExternalStore(subscribe, getNavState)` (documented recipe). Keeping `brustjs/navigation` **React-free and DOM-import-free** is a hard constraint so it can join the `typecheck:treaty` isolated-tsc gate.
- **Native `x-*` directive binding** to the nav store — that is B7 territory.
- **Server-side seeding / serialization** of nav state. Navigation state is inherently client-only; it initializes from `location` in the browser and is inert on the server.
- **Changing the server `/_brust/page` envelope.** No Rust changes. The feature is pure TS in `runtime/` + the pokedex example.

## High-level architecture

```
brustjs/navigation  (runtime/navigation/index.ts)   ← public entry, React-free, DOM-free
  ├─ runtime/navigation/store.ts      ← signal singleton + lifecycle hooks + subscribe helpers
  └─ runtime/navigation/active-nav.ts ← DOM consumer: active-link updater + html[data-brust-nav]

runtime/islands/bootstrap.ts  ← imports store hooks; calls them inside navigate() + on init
```

- **`store.ts`** owns a module-level singleton `nav` (a bag of `signal()`s) stashed on `globalThis.__BRUST_NAV__` so the bootstrap chunk and any island chunk share **one** instance. (The `Symbol.for` tracker in `signal.ts:11,53-58` is shared cross-chunk, but the `nav` *object* is not — without the stash each chunk builds its own bag. The stash is necessary and is the object-identity fix.) (Signals already share their reactive tracker cross-chunk via `Symbol.for`, per `runtime/store/signal.ts`; the stash makes the *object* identity shared too.) It is built with `signal()` directly — **not** `defineStore` — because `defineStore.resolve()` throws on the server when no request scope exists (`runtime/store/define-store.ts:120-122`), and nav state must be SSR-safe and never serialized.
- **`active-nav.ts`** is the only DOM-touching file; `store.ts` stays DOM-free (it reads `location` behind a `typeof window` guard only inside `__navInit`). `installActiveNav()` runs an `effect()` over `nav.path` and, on each change, reconciles `is-active` + `aria-current="page"` across links inside `[data-brust-nav]` containers.
- **`bootstrap.ts`** calls `__navStart` before the fetch, `__navCommit` after the swap, `__navError` in the catch, and `__navInit` once on load (which also calls `installActiveNav`).

## API surface — `brustjs/navigation`

```ts
export type NavPhase = 'idle' | 'loading' | 'success' | 'error'

export interface NavState {
  path: string          // committed pathname (no search)
  search: string        // committed search incl. leading '?', or ''
  phase: NavPhase
  error: Error | null
  from: string | null   // pathname navigated away from (null on first load)
  to: string | null     // pending target pathname during 'loading' (null when not loading)
}

// Reactive source of truth — read inside effect()/native runtime to track changes.
// Shared singleton across bundle chunks via globalThis.__BRUST_NAV__.
export const nav: {
  path: Signal<string>
  search: Signal<string>
  phase: Signal<NavPhase>
  error: Signal<Error | null>
  from: Signal<string | null>
  to: Signal<string | null>
}

// Plain non-reactive snapshot (for useSyncExternalStore getSnapshot / logging).
export function getNavState(): NavState

// Fire `cb` on ANY nav state change. Returns an unsubscribe fn.
export function subscribe(cb: (state: NavState) => void): () => void

// Lifecycle hooks (the "watch" surface):
export function onBeforeNavigate(cb: (e: { from: string; to: string }) => void): () => void
export function onNavigate(cb: (e: NavState) => void): () => void          // commit/success
export function onNavigateError(cb: (e: { to: string; error: Error }) => void): () => void

// Internal — called ONLY by bootstrap.ts. Underscore-prefixed; not for app authors.
export function __navStart(toPath: string, toSearch: string): void
export function __navCommit(toPath: string, toSearch: string): void
export function __navError(toPath: string, error: Error): void
export function __navInit(): void
```

### State machine (exact transitions)

`__navInit()` (once, on load): `path/search ← location`; `phase ← 'idle'`; `from/to/error ← null/null/null`; sets `html[data-brust-nav="idle"]`; calls `installActiveNav()` (which reconciles the sidebar against the initial path). `from` is `null` **only** in the window between `__navInit` and the first `__navStart`; after the first navigation it is always a real pathname (never returns to `null`). Bootstrap calls `__navInit()` **before** `installInterceptor()` in both load branches (`bootstrap.ts:261-269`), so no click can fire `__navStart` before init — load-bearing for `from` correctness; the plan adds a test asserting this ordering.

`__navStart(toPath, toSearch)` (before fetch):
- `from ← nav.path()` (current committed path), `to ← toPath`, `phase ← 'loading'`, `error ← null`
- sets `html[data-brust-nav="loading"]`
- fires `onBeforeNavigate({ from, to })`

`__navCommit(toPath, toSearch)` (after successful swap):
- `path ← toPath`, `search ← toSearch`, `phase ← 'success'`, `to ← null`, `error ← null`
- sets `html[data-brust-nav="idle"]` (success is a transient logical phase; the DOM attr returns to idle so loading indicators clear)
- fires `onNavigate(getNavState())`
- the `nav.path` write triggers the active-nav `effect()` → sidebar reconciles

`__navError(toPath, error)` (catch, non-abort):
- `phase ← 'error'`, `error ← error`, `to ← null`
- sets `html[data-brust-nav="error"]`
- fires `onNavigateError({ to: toPath, error })`
- NOTE: `navigate()` then falls back to a full `location.href` reload (existing behavior, `bootstrap.ts:235`), which resets nav state on the fresh page. The error hook fires **before** that reload (useful for logging). Documented as a known limitation.

AbortError (a superseded in-flight nav): **no** state transition — `navigate()` returns early (`bootstrap.ts:233`). The newer navigation already called `__navStart` and owns the state.

**Intents that skip the lifecycle entirely** (no `__navStart`/`__navCommit`, by design — these never call `navigate()`):
- `'reload'` (clicking the already-active page, `bootstrap.ts:252`): no loading flash, `phase` stays `idle`. Expected; tested.
- `'hash'` (in-page anchor, `bootstrap.ts:248`) and `'external'`: browser-owned, `nav.*` untouched.

**Search-only navigation** (`/?a=1` → `/?a=2`, classified `'navigate'` at `bootstrap.ts:192`): `__navStart`/`__navCommit` fire with the **same** `path` but a new `search`. The active-nav `effect` keys on `nav.path` and **no-ops** (signal `set` is `Object.is`-equal → no notify, `signal.ts:101`) — correct, same active link. `nav.search` still changes, so `subscribe`/`onNavigate` consumers fire. Tested.

**Hook re-entrancy footgun:** `onNavigate`/`onBeforeNavigate` fire synchronously inside `navigate()`. A hook that calls `navigate()` synchronously would recurse — documented as "hooks must not trigger navigation synchronously" (a non-goal to guard against in code for v1).

### Built-in active-nav updater (`active-nav.ts`)

`installActiveNav()`:
- Runs `effect(() => { const p = nav.path(); reconcile(p) })` so it re-reconciles on every committed path change **and** once immediately (effect runs eagerly).
- `reconcile(currentPath)`:
  - For each container `el` matching `[data-brust-nav]`:
    - `activeClass = el.dataset.brustNavActive || 'is-active'`
    - `match = el.dataset.brustNavMatch === 'prefix' ? prefix : exact`
    - For each `a` in `el.querySelectorAll('a[href]')`:
      - `linkPath = new URL(a.href, location.href).pathname`
      - `isActive = match === 'prefix' ? (currentPath === linkPath || currentPath.startsWith(linkPath.replace(/\/$/, '') + '/')) : currentPath === linkPath`
      - toggle `a.classList.toggle(activeClass, isActive)` and set/remove `aria-current="page"`
- DOM-guarded: no-op if `typeof document === 'undefined'`.
- Idempotent: a **module-scoped install flag** in `active-nav.ts` ensures the `effect()` is installed only once even if `installActiveNav()` is called repeatedly. In production only one load branch fires, so double-install isn't reachable — the flag exists for tests, which call `__navInit`/`installActiveNav` repeatedly. **Tests must reset this flag AND `globalThis.__BRUST_NAV__` between cases** (export a `__resetNavForTest()` from `store.ts` that clears the singleton, and reset the active-nav flag, so the effect does not leak across test cases).

Authors opt in by adding `data-brust-nav` to a nav container (and optionally `data-brust-nav-active="<class>"` / `data-brust-nav-match="prefix"`). Links are plain `<a href>`; first-paint active state still comes from SSR (the existing AppLayout conditional), and the updater keeps it in sync on SPA nav.

## bootstrap.ts integration (exact edits)

1. `import { __navStart, __navCommit, __navError, __navInit } from '../navigation/store.ts'`
2. In `navigate(url, push)`:
   - immediately after entering the `try` (after aborting the prior controller), call `__navStart(url.pathname, url.search)`.
   - after `hydrateMarkersIn(main)` (the last success step), call `__navCommit(url.pathname, url.search)`.
   - in `catch`, after the `AbortError` early-return, call `__navError(url.pathname, err as Error)` before the `location.href` fallback.
3. Export `navigate` (add `export`) so the lifecycle wiring is unit-testable with a mocked `fetch` (consistent with the file's existing "exported for unit testing" convention).
4. In both the `DOMContentLoaded` and the already-loaded branches at the bottom, call `__navInit()` **before** `installInterceptor()` (so the nav store + active-nav are wired before any click).

No other bootstrap behavior changes. The `__navStart`/`__navCommit`/`__navError` calls also cover the popstate path for free (popstate calls the same `navigate()`).

## package.json + tsc gate

- Add to `exports`: `"./navigation": "./runtime/navigation/index.ts"`.
- Extend `runtime/tsconfig.typecheck.json` `files` with `navigation/index.ts`, `navigation/store.ts`, `navigation/active-nav.ts` (all React-free, DOM types only — `active-nav.ts` uses `lib.dom`, which the typecheck tsconfig already provides via default libs). This is the repo's only working tsc gate (full-project tsc stack-overflows).

## pokedex consumption (`AppLayout.tsx` + CSS)

1. **`AppLayout.tsx`**: add `data-brust-nav` to the sidebar `<nav className="aa-sidebar__nav">`. Keep the existing SSR conditional-element active rendering for first paint (native-template-safe). No other structural change. (The native compiler accepts static `data-*` attributes; only *dynamic* content is member-path/`.map`-restricted.)
2. **Loading indicator (CSS only)**: add a top progress bar to `example/pokedex/app.css` (the single stylesheet; `aa-nav-item` lives at `app.css:1112`, `.is-active` at `app.css:1129`). Implement as a `position:fixed` `body::before` bar gated by the `<html>` attribute, exact selector **`html[data-brust-nav="loading"] body::before`** (the attr is on `<html>` per `brust-page.tsx:87-90`; `body { margin:0 }` at `app.css:431` and the `.aa-app` grid is a child of `<body>`, so a fixed `::before` escapes the grid). Use `z-index` **above** the sticky topbar (`.aa-topbar { z-index:10 }`, `app.css:1165`) — e.g. `z-index:9999`. Add an error tint via `html[data-brust-nav="error"] body::before`. Pure CSS, no JS, no markup in the example.

## Tests

- **`runtime/navigation/store.test.ts`** (no DOM needed; guard `window`): `__navStart` sets `phase='loading'`, `from`/`to`; `__navCommit` sets `path`/`search`/`phase='success'`, clears `to`; `__navError` sets `phase='error'`/`error`; `onBeforeNavigate`/`onNavigate`/`onNavigateError` fire with correct payloads and unsubscribe; `subscribe` fires on any change; `getNavState()` returns a plain snapshot; cross-chunk singleton (same `nav` ref via globalThis). Reset `globalThis.__BRUST_NAV__` between tests.
- **`runtime/navigation/active-nav.test.ts`** (DOM harness — mirror the DOM setup in `runtime/islands/bootstrap.test.ts`): given a `[data-brust-nav]` container with `<a href="/">`/`<a href="/type-chart">`, committing `path='/type-chart'` toggles `is-active` + `aria-current` onto the matching link and off the others; `data-brust-nav-active` overrides the class; `data-brust-nav-match="prefix"` activates `/foo/bar` for an `/foo` link; runs correctly on initial `installActiveNav()`.
- **`runtime/islands/bootstrap.test.ts`** (extend): the suite uses **happy-dom** (`new Window()` + `Object.assign(globalThis, {...})` in `beforeAll`) and `mock.module` for island chunks — but it does **NOT** mock `fetch` today, and `navigate` is not currently exported/tested. The extension must **introduce** a `fetch` mock: `globalThis.fetch = mock(async () => ({ ok: true, json: async () => ({ html: '<p>x</p>', title: 'T', store: undefined }) }))` (return `store: undefined` so `applyStoreSnapshot` is skipped — `bootstrap.ts:227` guards on truthiness). Then calling the now-exported `navigate(url, true)` drives `nav.phase` `loading → success` (assert via `subscribe`/`getNavState()`) and commits `nav.path`. **Import-time footgun:** importing `bootstrap.ts` runs `installInterceptor()` + `__navInit()` at module load (DOM present), which mutates `globalThis.__BRUST_NAV__` and sets `html[data-brust-nav]`. Reset the nav singleton in `beforeEach` via `__resetNavForTest()`. `active-nav.test.ts` must **not** import `bootstrap.ts` (would double-install the interceptor + effect); it imports `store.ts` + `active-nav.ts` directly.

Run separately from combined integration suites (native-island port-race flake — see memory). The store + active-nav tests need a DOM only for `active-nav` (mirror bootstrap.test.ts's happy-dom `beforeAll`); `store.test.ts` itself is DOM-free except `__navInit` (guard or stub `location`).

## Acceptance criteria

1. `bun run typecheck:treaty` exit 0 with the three new files in the gate.
2. `bun test runtime/navigation/` green; extended `bootstrap.test.ts` green; full `bun test runtime/` green (no regressions).
3. `bun run ci` (biome) clean. (No Rust change — the TS gate is biome + `typecheck:treaty`, per memory; a `cargo` re-run is a sanity check, not a gate for this feature.)
4. Manual/dev smoke (pokedex): click `/` → `/type-chart` via SPA nav (no full reload), the sidebar highlight moves to "Type chart"; clicking back (popstate) moves it to "All Pokémon"; `html[data-brust-nav]` flips to `loading` during the fetch then back to `idle` on commit (the attr only ever holds `idle`/`loading`/`error` — the `'success'` *phase signal* maps to the `idle` attr value so loading indicators clear). Verified by me in Phase 6, not just subagent-reported.
5. `brustjs/navigation` is import-clean from a non-DOM context (the tsc gate proves no DOM/React static import in `store.ts`/`index.ts`; `active-nav.ts` may use DOM libs but must not statically import React).

## Known limitations

- `onNavigateError` fires immediately before a full-page fallback reload (the existing `navigate()` failure behavior), so `phase='error'` is observable only transiently before the reload resets state.
- First-paint active state in `AppLayout` still relies on the SSR conditional; the client updater reconciles only from the first `installActiveNav()` onward (no flash, since the effect runs synchronously at init).
- `subscribe` coalesces: it fires once per signal write that actually changes a value (signal `set` is no-op on `Object.is`-equal writes). Multiple signal writes in one transition (e.g. `__navCommit` writes path+search+phase) fire `subscribe` multiple times; consumers needing a single callback per transition should use `onNavigate`/`onBeforeNavigate`/`onNavigateError` instead.

## Open questions resolved at plan-time

- **Plain singleton vs defineStore:** plain `signal()` singleton (resolved above — server-safety + no serialization).
- **Active-link opt-in:** container marker `data-brust-nav` (not per-link, not automatic-on-all-`<a>`).
- **Match semantics:** exact by default, `prefix` opt-in via `data-brust-nav-match`.
