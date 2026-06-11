---
title: Store
description: Signals, defineStore, effects — one isomorphic reactive core for islands, behaviors, and the server.
nav: { group: "Concepts", order: 4 }
---

`brustjs/store` is a small framework-free reactive core: signals, computeds,
effects, and a `defineStore` that gives the same store code different scoping
on each side — a window singleton in the browser, a per-request instance on
the server. Islands (React) and behavior components (no React) share it, so
state crosses the paradigm boundary for free.

## Exports

| Export | Signature | Description |
|---|---|---|
| `signal` | `signal<T>(initial): Signal<T>` | A readable/writable reactive value. Read by calling it (`count()`), write with `count.set(next)` or `count.set(prev => …)`. Writes are equality-checked with `Object.is` — setting the same value notifies nothing. |
| `computed` | `computed<T>(fn): Computed<T>` | A lazily-cached derived value; recomputes on next read after a dependency changes. |
| `effect` | `effect(fn): dispose` | Runs `fn` now and re-runs it when any signal it read changes. `fn` may return a cleanup (React `useEffect` semantics): it runs before each re-run and on dispose. Returns a disposer. |
| `batch` | `batch(fn): void` | Groups multiple writes; effects run once after the batch instead of per write. |
| `defineStore` | `defineStore<S>(name, factory): StoreHandle<S> & S` | A named store (below). |
| `isSignal` / `isComputed` | type guards | Recognize signals/computeds across chunks. |

```ts
import { signal, computed, effect, batch } from 'brustjs/store'

const count = signal(0)
const double = computed(() => count() * 2)

const dispose = effect(() => {
  console.log('count is', count())
  return () => console.log('cleanup before next run / on dispose')
})

batch(() => {
  count.set(1)
  count.set((p) => p + 1)
}) // one effect re-run, not two
```

These are also re-exported from the main `brustjs` entry; `brustjs/store`
itself is react-free and safe to import from behavior chunks.

## defineStore

A store is a named factory of signals, computeds, and actions:

```ts
// stores/team.ts
import { defineStore, signal, computed } from 'brustjs/store'

export const teamStore = defineStore('team', () => {
  const members = signal<string[]>([])
  const full = computed(() => members().length >= 6)
  function add(name: string) {
    members.set((m) => [...m, name])
  }
  return { members, full, add }
})

// anywhere: property access resolves the right instance for the environment
teamStore.add('pikachu')
teamStore.members() // ['pikachu']
```

The handle is a proxy — `teamStore.members` resolves the instance lazily on
each access. It also exposes `subscribe(cb)`, `snapshot()` (plain-value view:
each `Signal<T>`/`Computed<T>` key becomes `T`, functions are dropped),
`serialize()`, and `hydrate(state)`.

### Scoping: client singleton, server per-request

- **In the browser** the instance lives in a window-level registry
  (`window.__BRUST_STORES__`), created on first access — one shared instance
  per store name across every island chunk and behavior chunk on the page.
- **On the server** the instance is **per request**, held in an
  `AsyncLocalStorage` scope that wraps each request's loaders and render.
  Two concurrent requests never see each other's writes. Accessing a store on
  the server outside a request scope throws.

### SSR snapshot to the client

If a request's loaders or render touched a store, the server serializes the
touched stores' signal values into the HTML as
`<script type="application/json" data-brust-store="<name>">` tags (escaped
against `</script>` breakout). On the client, the **first access** to a store
finds its script tag and hydrates the matching signal keys — so a store
seeded in a loader arrives on the client already holding the SSR values. This
works on both React routes and native routes (native pages carry the snapshot
in a framework-owned head slot).

```ts
// loader (server): seed the per-request instance
loader: async () => {
  teamStore.members.set(await loadTeam())
  return {}
}
// client: first teamStore access hydrates members from the page
```

## Using a store in an island

In React, subscribe with `useStore` from `brustjs/client` — a
`useSyncExternalStore` adapter that returns the plain-value snapshot:

```tsx
import { useStore } from 'brustjs/client'
import { teamStore } from '../stores/team'

export default function TeamBuilder() {
  const { members, full } = useStore(teamStore) // members: string[], full: boolean
  return (
    <button disabled={full} onClick={() => teamStore.add('eevee')}>
      Team ({members.length}/6)
    </button>
  )
}
```

Reads come from the snapshot; writes go through the handle (`teamStore.add`,
`teamStore.members.set`). The component re-renders only when a signal value
actually changes.

## Using a store in a behavior

Behavior components use the store directly — no hook, no adapter:

```ts
import type { BehaviorCtx } from 'brustjs/native'
import { computed } from 'brustjs/store'
import { teamStore } from '../stores/team'

export const behavior = ({ effect }: BehaviorCtx) => {
  const count = computed(() => teamStore.members().length)
  effect(() => {
    document.title = `Team (${count()})`
  })
  return { count, add: () => teamStore.add('snorlax') }
}
```

### Why this works across bundles

Every island and behavior chunk is a separate build that inlines its own copy
of the store module. The reactive core anticipates this: the signal/computed
brands and the dependency-tracking context live on `globalThis` under
`Symbol.for` keys, identical across chunks. So a native `x-on-click` in one
chunk writing `teamStore` is observed reactively by a React island from
another chunk reading the same store — this is dogfooded in the pokedex
example, where a native add-to-team button drives a React team-dock island.

## Effects with cleanup

`effect` cleanups run **untracked** — a signal read inside a cleanup never
registers a dependency — and the disposer is safe against re-entrancy (a
cleanup that writes a signal the effect depends on won't resurrect a disposed
effect). In behaviors, prefer the `effect` handed to you in `BehaviorCtx`: it
is the same function, but its disposer auto-joins the component's teardown so
SPA navigations can't leak effects.

## Next

Mutate server state from the client with typed endpoints:
[Actions](/docs/actions).
