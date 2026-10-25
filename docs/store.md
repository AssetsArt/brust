# The unified store

A store is a named bag of signals that every part of a brust page can read and write: a server loader, a native component, a React island. One name, one value, three surfaces. The server seeds it, the first paint already shows the value, and a click in one place updates every other place with no reload.

This page covers `@brust/core/store` and `@brust/core/store/react`. The pokedex example (`examples/pokedex`) uses it for the team and for the `/unified` demo; the snippets below are taken from there.

## 1. One store, every surface

| Where | How it touches the store | What it gets |
|---|---|---|
| A loader (server) | `team.members.set(...)` | Writes the per-request instance. The values go into the page as a snapshot. |
| A native component | `const s = useStore(team)` in render | `s.members` is painted by the server and updated live in the browser. |
| A React island | `const { members } = useStore(team)` | The same snapshot on the server (so hydration matches) and live updates in the browser. |
| An event handler or effect | `team.members.set(...)` | Writes the one browser instance; every reader updates. |
| An action (Elysia) | the same handle | A per-request instance; it never reaches the page (see section 8). |

## 2. `defineStore`

```ts
// stores/team.ts
import { defineStore, signal } from '@brust/core/store'
import type { TeamMember } from '../lib/types'

export const team = defineStore('team', () => ({
  members: signal<TeamMember[]>([]),
  max: signal(6),
}))
```

- The first argument is the store name. Keep it free of `.` and `[` (`team`, not `pokedex.team`): a dotted name makes the compiler fall back to a coarse cache input and warn `store-name-dotted`.
- The handle is a proxy. `team.members` resolves the right instance for the environment on every access: the browser singleton, or the current request's instance on the server.
- Reserved handle members are `name subscribe snapshot serialize hydrate then`. A factory cannot use them as keys.
- `team.snapshot()` is the plain-value view (a `Signal<T>` key becomes `T`; functions are dropped). `team.serialize()` is what goes into the page: top-level signals only.
- Two `defineStore` calls with one name and different factories: the first wins, and the compiler warns `store-name-duplicate`.
- `signal`, `computed`, `effect`, `batch`, `untracked`, `isSignal` and `isComputed` come from the same entry. `@brust/core/store` is React-free and safe in any chunk.

## 3. Scoping

- **Browser.** One instance per name, on `globalThis[Symbol.for('brust.stores')]`. Every chunk on the page (each island and each native component is its own bundle) shares it, because the signal brands and the dependency-tracking context also live on `globalThis` under `Symbol.for` keys.
- **Server.** One instance per request: the loader chain, the island render and the action `fetch` each run in their own scope. Two concurrent requests never see each other's writes.
- **Outside a scope** the server throws, with these exact messages:
  - `store '<name>' accessed outside a request scope` (the server resolver is installed, but no request is running);
  - `store '<name>' accessed on the server without a request scope` (no resolver is installed).

  `useStore` returns `{}` during a server render outside a scope.

## 4. Seeding and the snapshot

Write the store in a loader. The pokedex seeds `team` once, in the layout loader, so every page under the layout paints the database roster:

```ts
// lib/loaders.ts
export function layoutLoader(): void {
  team.members.set(teamDb().list())
  team.max.set(MAX_TEAM)
}
// routes.tsx: { Component: AppLayout, loader: layoutLoader, children: [ ... ] }
```

- The server serializes each touched store into the page as `<script type="application/json" data-brust-store="team">{...}</script>`, one tag per store, sorted by name, immediately before the runtime script. The JSON is escaped against `</script>` breakout.
- On the first access in the browser, the store finds its tag and hydrates the matching signal keys. A store seeded in a loader arrives holding the server values.
- A store that a component reads at render is snapshotted even when no loader wrote it: the worker touches every store the route's components declare. Without a write it simply holds its factory defaults.
- A `notFound` verdict carries the snapshot (its template renders); a redirect or an error does not.
- A page with no store gets no tag and is byte-identical to a page built without the store feature.

## 5. Native components: render-time reads

A native component is compiled to a server template plus a small browser chunk, with no React. `useStore` is a native-tier hook:

```tsx
// components/AddToTeamButton.tsx
import { useStore } from '@brust/core/store/react'
import { useState } from 'react'
import { toggleMember } from '../lib/team-client'
import { team } from '../stores/team'

export default function AddToTeamButton({ id }: { id: number }) {
  const s = useStore(team)
  const [busy, setBusy] = useState(false)
  const inTeam = s.members.some((m) => m.id === id)
  const full = !inTeam && s.members.length >= s.max
  return (
    <button type="button" disabled={busy || full}
      onClick={async () => { setBusy(true); try { await toggleMember(id, inTeam) } finally { setBusy(false) } }}>
      {inTeam ? 'In your team' : full ? 'Team Full' : 'Add to team'}
    </button>
  )
}
```

- `s.members` in render is painted from `__store.team.members` on the server and re-read from the signal in the browser, so the text and the `disabled` state follow the store live.
- A value derived from a store read (`inTeam`) becomes a precompute slot whose inputs include `__store.team.members`; the browser recomputes it on every change.
- The rules, each enforced by a named diagnostic, and each falling back to the React tier (never a build failure):
  - read only top-level `signal(...)` keys of the factory (`store-key-unsupported` otherwise: a computed, a plain value or an action has no value on the server);
  - write only in handlers and effects (`store-write-in-render`);
  - read through the view, never `team.members()` in render (`store-handle-in-render`);
  - define the store in its own module, imported by the component (`store-name-unresolved` for a store declared inside the component file, or one whose name is not a string literal).

## 6. React islands

An island reads the store with the same hook:

```tsx
// components/TeamBuilder.tsx (trimmed)
import { useStore } from '@brust/core/store/react'
import { useReducer, useTransition } from 'react'
import { team } from '../stores/team'

const flip = (open: boolean): boolean => !open

export default function TeamBuilder() {
  const { members, max } = useStore(team) // plain values, not signals
  useTransition() // a hook the native tier does not lower: this is what keeps the component an island
  const [open, toggle] = useReducer(flip, false)
  return (
    <button type="button" onClick={() => toggle()}>
      My team {members.length} / {max} {open ? '(open)' : ''}
    </button>
  )
}
```

`useStore` is `useSyncExternalStore`. During the server render it reads a scope seeded from the page snapshot, so the first client snapshot equals the server HTML: no `mounted` switch, no hydration mismatch, and the count is right with JavaScript disabled. A write anywhere re-renders the island only when a value it reads changed. In the browser the first client snapshot is the one the page was seeded with (the SSR snapshot), not the live value: a native component that writes the store before an idle island hydrates no longer causes a mismatch (React #418). The island hydrates against the seeded markup, then re-renders to the live value.

Note: `useStore` alone compiles to the native tier. An island needs another React feature that the native tier does not lower (the pokedex uses `useTransition`; `useReducer` itself compiles natively) to land on the React tier.

## 7. Caching

- The snapshot rides inside the cached page, and inside the island job's cache key, so a cached page and its store always agree.
- A per-user value in a store plus an L1 page cache is the same mistake as a per-user value in a loader plus an L1 cache, with or without stores. Do not cache pages that paint per-user store data.
- For shared data like the pokedex team, tag the cached pages and evict the tag after a real change:

  ```ts
  // routes.tsx:   cache: { ttl_seconds: 60, tags: ['pokemon', 'team'], bypass: 'query(nocache)' }
  // actions.ts:   if (db().add(member) === 'added') cache.invalidate({ tags: ['team'] })
  ```

  `?nocache=1` stays the read-fresh escape.

## 8. Actions and stores

A store written inside an action is per-request and never reaches the page. Persist the change, return the data, and set the store in the browser with the reply:

```ts
// lib/team-client.ts
export async function removeMember(id: number): Promise<void> {
  const r = await api.team({ id }).delete()
  if (r.data) { team.members.set(r.data.team); team.max.set(r.data.max) }
}
```

Every UI surface then updates because they all read `team`. See [Actions](./actions.md) for the app and the typed client.

## 9. Limits

- No selectors and no nested signals: `useStore` returns the whole snapshot; only top-level signals are serialized.
- `Map`, `Set` and `Date` serialize to `{}`. A `BigInt` throws at serialization and names the store and the key. Functions and `undefined` are dropped.
- The snapshot size is unbounded: put page-level state in a store, not a large dataset.
- A store module's top-level code can run more than once in a worker, so keep store modules free of side effects. The pokedex keeps sqlite out of `stores/team.ts` for that reason.
- A store that is already live keeps its client value across an SPA navigation. The new page's snapshot only seeds a store the tab has not used yet; it never overwrites a live one. See [Navigation](./navigation.md).

## 10. The built-in `navigation` store

brust ships one store of its own, `navigation`, fed by the SPA navigation events (`state`, `url`, `to`, `trigger`, `status`, `error`, `id`). Import the handle from `@brust/core/navigation` and read it through `useStore` like any other store, in a native component or an island. The name is reserved. See [Navigation](./navigation.md#8-the-navigation-store).

## 11. Example

- `examples/pokedex`: `stores/team.ts`, `components/AddToTeamButton.tsx` (native), `components/TeamBuilder.tsx` (island), the layout loader in `lib/loaders.ts`, `actions.ts` and `lib/team-client.ts`.
- `/unified` (`pages/UnifiedPage.tsx`): a React island counter, a native counter and a read-only native node on the store `unified`. `/unified?start=5` seeds the first paint with 5.

## 12. Next

Mutate server state from the client with typed endpoints: [Actions](./actions.md).
