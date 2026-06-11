---
title: Navigation
description: Client-side navigation — link interception, the reactive nav store, useNav, NavLink-style behaviors, and live active links. Works on the live server and on static exports.
nav: { group: "Concepts", order: 5 }
---

brust pages navigate like a SPA without you wiring anything: the hydration
bootstrap (shipped whenever a page hosts at least one island) intercepts
internal link clicks, fetches the target page's payload, and swaps `<main>`
in place — no full reload, shared chrome stays alive. `brustjs/navigation`
is the reactive window into that machinery: a store every paradigm can watch
(React islands via `useNav`, behavior components via signals) plus an
imperative `navigate()`.

Everything on this page works identically on a **static export** — `brust
build --ssg` writes each route's navigation payload as a static file, so the
docs site you are reading navigates client-side with no server at all.

## How a navigation happens

On an intercepted click the navigator:

1. fetches `/_brust/page<path>` — a JSON payload `{ html, title, store }`
   where `html` is the target page's inner `<main>` content
2. unmounts islands inside the current `<main>`, swaps in the new content
3. applies the store snapshot, updates `document.title`, pushes history,
   scrolls to top, and hydrates any islands in the new content

Back/forward (`popstate`) runs the same swap without pushing a new entry.

Clicks the navigator deliberately leaves to the browser:

| Click | Behavior |
|---|---|
| Cross-origin, `target` set, `download`, modifier/middle click | normal browser navigation |
| `data-brust-no-intercept` on the `<a>` | opt-out — always a full load |
| Same path+query, different `#hash` | native in-page scroll |
| The exact current URL | no-op (no refetch, no reload) |

And when a client-side swap cannot be correct, it **falls back to a full
load** instead of guessing: payload missing or non-200, payload that is a
full document (the target owns its own shell — there is no shared `<main>`
to swap into), or the current page has no `<main>`. Cross-shell navigations
— like this site's docs ↔ Home — full-reload for exactly that reason.

The swap replaces `<main>`'s children only. Anything per-page must live
inside `<main>` (this site's prev/next pager does); anything outside it —
header, sidebar — persists across navigations, which is what makes the
[active-link reconciler](#live-active-links) and [nav store](#the-nav-store)
useful.

## The nav store

`brustjs/navigation` is React-free and DOM-free at import. All state lives in
one cross-chunk singleton — a bag of [signals](/docs/store) the navigator
writes on every transition:

| Export | Signature | Description |
|---|---|---|
| `nav` | `{ path, search, phase, error, from, to }` | Signals. Read inside a `computed`/`effect` and it re-runs on every navigation. `phase` is `'idle' \| 'loading' \| 'success' \| 'error'`. |
| `getNavState` | `(): NavState` | Plain-value snapshot of all six fields (referentially stable between transitions). |
| `subscribe` | `(cb: (s: NavState) => void): unsubscribe` | Fires on every transition (start, commit, error). |
| `onBeforeNavigate` | `(cb: ({ from, to }) => void): unsubscribe` | Before the payload fetch starts. |
| `onNavigate` | `(cb: (s: NavState) => void): unsubscribe` | After a navigation commits. |
| `onNavigateError` | `(cb: ({ to, error }) => void): unsubscribe` | When a navigation fails (the full-load fallback still happens). |
| `navigate` | `(path, { query?, replace? }?): Promise<void>` | Imperative SPA navigation (below). |
| `buildSearch` | `(query: QueryInit): string` | Serialize a query object to `?…` (or `''`). |
| `installActiveNav` | `(): void` | Installs the active-link reconciler. The bootstrap calls this for you — exported for non-standard setups only. |

### `navigate()` — imperative navigation

```ts
import { navigate, buildSearch } from 'brustjs/navigation'

await navigate('/docs/routing')                          // push
await navigate('/search', { query: { q: 'island', page: 2 } })
await navigate(location.pathname, { query: { page: null }, replace: true })

buildSearch({ tags: ['a', 'b'], page: 2 })               // '?tags=a&tags=b&page=2'
```

`query` merges over any query already in `path`: each key replaces all
existing occurrences, arrays append one param per item, and `null`/
`undefined` **deletes** the key — so `{ page: null }` clears a param.
`replace: true` uses `history.replaceState` (no new back-stack entry).

`navigate()` is client-only (it throws during SSR), and on a page with no
navigator (no islands bootstrap) it degrades to a full-document load — the
call still navigates.

### Watching from a behavior (the NavLink pattern)

`nav` is a plain reactive source, so a zero-React
[behavior component](/docs/native-interactivity) can drive its own active
state — re-evaluated on every client-side navigation:

```tsx
// components/NavLink.tsx — single-file native component
import { nav } from 'brustjs/navigation'
import { computed } from 'brustjs/store'

export const behavior = ({ el }: { el: HTMLElement }) => {
  const linkPath = new URL((el as HTMLAnchorElement).href, location.href).pathname
  return {
    cls: computed(() => (nav.path() === linkPath ? 'nav-link is-active' : 'nav-link')),
    current: computed(() => (nav.path() === linkPath ? 'page' : null)),
  }
}

export default function NavLink({ href, label }: { href: string; label: string }) {
  return (
    <a x-bind-class="cls" x-bind-aria-current="current" className="nav-link" href={href}>
      <span>{label}</span>
    </a>
  )
}
```

The behavior reads the link's own `href` off the element — no props plumbing
— and `x-bind-aria-current` removes the attribute when the computed returns
`null`. The [pokedex example](https://github.com/AssetsArt/brust/blob/main/example/pokedex/components/NavLink.tsx)
ships exactly this.

## `useNav()` in React islands

The React adapter lives in `brustjs/client` (so `brustjs/navigation` stays
React-free). An island re-renders on every transition — this site's top
progress bar is the whole pattern:

```tsx
// components/NavPreloader.tsx — REACT ISLAND
import { useNav } from 'brustjs/client'

export default function NavPreloader() {
  const { phase } = useNav()
  if (phase !== 'loading') return null
  return (
    <div className="preloader-bar" role="progressbar" aria-label="Loading page">
      <div className="preloader-fill" />
    </div>
  )
}
```

Mount it **outside `<main>`** (`<Island component={NavPreloader} />` in a
layout) so the swap never tears down the island that is indicating the swap.
During SSR `useNav()` returns the idle defaults; the client picks up live
state on hydration.

## Live active links

Re-rendering a whole sidebar per navigation would defeat the point of the
swap. Instead, mark any container and the runtime **reconciles its links** on
every navigation — it moves `aria-current="page"` (and toggles a class) onto
whichever `<a>` matches the new path:

```html
<nav aria-label="Docs" data-brust-active-nav>
  <a href="/docs/routing">Routing</a>
  <a href="/docs/store">Store</a>
</nav>
```

| Attribute (on the container) | Default | Meaning |
|---|---|---|
| `data-brust-active-nav` | — | Opt in: links inside are reconciled on every navigation. |
| `data-brust-active-match="prefix"` | exact | Also match descendants — `/docs/store` keeps `/docs` active. |
| `data-brust-active-class="…"` | `is-active` | Class toggled alongside `aria-current`. |

Style the active state off the attribute and the server-rendered first paint
and every client-side navigation share one rule:

```css
nav[data-brust-active-nav] a[aria-current='page'] {
  color: var(--link);
  font-weight: 500;
}
```

This site's sidebar is exactly this: the server renders `aria-current` on
the right link, the reconciler moves it on every swap.

### CSS-only loading indicators

The runtime mirrors the phase to `<html data-brust-nav="idle | loading |
error">`, so a pure-CSS indicator needs no island at all:

```css
html[data-brust-nav='loading'] .topbar {
  opacity: 0.6;
}
```

## On static exports

`brust build --ssg` writes each route's payload to
`_brust/page/<path>/index.html` — the exact URL the navigator fetches — so
all of the above (swaps, the store, active links, `navigate()`) behaves the
same on a dumb static host as on the live server. Unknown routes 404 → the
navigator's full-load fallback covers it. See
[Markdown Pages → Static export](/docs/markdown-pages#static-export---ssg).

## Next

Mutate data with typed [Actions](/docs/actions), or see how the
[Store](/docs/store) carries state across the boundary a navigation swaps.
