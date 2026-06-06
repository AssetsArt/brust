# Native `behavior` ctx `effect()` — React-style reactive effects

Date: 2026-06-06
Status: implemented (pipeline review pending)

## Goal

Give native single-file-component `behavior` authors a first-class, lifecycle-bound
way to run **reactive side-effects** — code that re-runs when the signals it reads
change, and is automatically torn down when the component unmounts (incl. SPA-nav
swap). The API mirrors React `useEffect`: the effect callback may **return a cleanup
function** that runs before each re-run and once on unmount.

```ts
export const behavior = ({ effect }) => {
  const theme = signal('light')
  effect(() => {
    document.documentElement.dataset.theme = theme()
    localStorage.setItem('theme', theme())
    return () => {/* optional cleanup */}
  })
  return { theme }
}
```

## Non-goals

- **No `x-effect` directive.** A markup-driven (`<div x-effect="method">`) Alpine-style
  effect was explicitly rejected by the user ("คล้ายๆ react"). Effects are authored in
  the `behavior` body only.
- **No instance `effects[]` key.** Rejected in favour of the ctx-param form.
- **No Rust / jsx compiler change.** The build only text-detects `export const
  behavior`; the ctx is provided entirely at runtime. No `.node` rebuild.
- **No change to `init()`.** The existing one-shot `init()` lifecycle stays as-is.
- **No `untrack`/`onMount`/`watch` primitives.** Out of scope; only `effect` +
  `onCleanup` are added.

## High-level architecture

Two layers:

1. **Reactive core (`runtime/store/signal.ts`)** — `effect()` learns the React
   returned-cleanup contract. The store is the shared cross-chunk reactive tracker
   (see the `Symbol.for` ctx note in that file), so this is the right home for the
   primitive — directives and islands benefit too.

2. **Native directive runtime (`runtime/native/runtime.ts`)** — `mountElement`
   constructs the component's disposer set *before* invoking `behavior(...)`, and
   passes two helpers into the behavior ctx whose teardown auto-joins that set.

## API surface

### `store/signal.ts`

```ts
// before
export function effect(fn: () => void): () => void
// after (widened return; backward-compatible)
export function effect(fn: () => void | (() => void)): () => void
```

- If `fn` returns a function, that cleanup runs **before each subsequent re-run** and
  **once when the returned disposer is called** (dispose).
- Cleanups run **UNTRACKED**: `ctx.activeConsumer` is set to `null` around the call,
  so a signal read inside a cleanup registers no dependency.
- A cleanup that throws is caught and logged (`console.error('[brust] effect cleanup
  threw:', e)`) — it must not break disposal of siblings.
- A `void` return is the unchanged no-cleanup path.

### `native/runtime.ts`

```ts
export interface BehaviorCtx {
  el: HTMLElement
  props: unknown
  effect: (fn: () => void | (() => void)) => () => void  // disposer auto-joins lifecycle; returns it too
  onCleanup: (fn: () => void) => void                    // one-shot teardown on unmount
}
export type Behavior = (ctx: BehaviorCtx) => Instance
```

- `effect(fn)` wraps store `effect`, pushes the disposer onto the element's
  `m.disposers`, and returns it.
- `onCleanup(fn)` pushes a teardown onto `m.disposers`.
- Existing behaviors `({ el, props }) => …` are unaffected (extra ctx fields ignored).

## Behavior / lifecycle invariants

- **Disposer set built first.** `m.disposers` is created before `behavior(...)` is
  invoked so a ctx `effect` (which runs immediately during `behavior()`) can register.
- **Mount ordering.** ctx effects register during `behavior()`; directive effects
  (`x-text`/`x-show`/`x-bind`/`x-for`) register later during `bindTree`. On
  `disposeElement` all disposers run (order: ctx effects first, then directives).
- **`mounted.set(el, m)` placement.** Stays after `behavior()` (unchanged from before
  — behavior() was always called before `mounted.set`), so no double-mount regression.
- **Re-mount (SPA nav).** A removed subtree's `disposeTree` runs every disposer,
  including the ctx-effect final cleanup; a later re-scan re-mounts fresh. No leak, no
  duplicate effect.

## Tests

`runtime/store/signal.test.ts`:
- effect returned cleanup runs before each re-run AND once on dispose (exact order).
- effect cleanup runs UNTRACKED — a signal read in cleanup adds no dependency.
- effect with no returned cleanup (void) still works and disposes cleanly.

`runtime/native/runtime.test.ts` (`describe('behavior ctx: effect + onCleanup')`):
- ctx.effect runs reactively; disposer joins lifecycle (no run after unmount).
- ctx.effect returned cleanup runs before re-run and once on unmount.
- ctx.onCleanup registers a teardown that runs on unmount.

## Acceptance criteria

- [ ] `bun test runtime/store runtime/native` green (incl. 6 new tests).
- [ ] `bun test runtime/` green (no regression — full suite).
- [ ] `bun run ci` (biome) clean — 0 warnings.
- [ ] `bun run typecheck:treaty` exit 0.
- [ ] No Rust change; no `.node` rebuild required.

## Known limitations / deferred

- `void | (() => void)` trips biome `noConfusingVoidType`; suppressed with
  `biome-ignore` + rationale (swapping to `undefined` would type-error every
  cleanup-less caller, since a no-`return` arrow infers `void`). This is the React
  `useEffect` return shape and is intentional.
- No `untrack` helper for reading signals without subscribing inside a *running*
  effect body (only cleanup is untracked). Deferred until a real need appears.
- Not dogfooded in `example/pokedex` yet (e.g. `ThemeToggle`). Optional follow-up.

## Open questions resolved at plan-time

- **Where does returned-cleanup live — store or native wrapper?** → store, so cleanup
  runs untracked with direct access to `ctx.activeConsumer`; a native-only wrapper
  couldn't suspend tracking without an exported `untrack`.
- **ctx param vs instance key vs directive?** → ctx param (user choice).
