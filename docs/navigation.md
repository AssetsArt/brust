# Navigation: SPA links, events and `navigate()`

A link click in a brust app does not reload the page. brust fetches the real HTML of the target URL and swaps it in place. The result is the same page a full load of that URL would show, and the browser never leaves the document. A page that cannot be swapped is loaded the normal way, so a link always works.

You write nothing for this. Every full document carries a small `nav` script (`<script type="module" src="/_brust/client/nav-<hash>.js" data-brust-nav …>`), also pages that are all static and load no runtime. `brust build --target static` output has it too, so a static site navigates the same way.

## 1. The one rule

> A navigation shows exactly what a full load of that URL would show. Only JavaScript state that lives outside the page survives: live stores, module-level state, and elements you marked `data-brust-persist`.

When you are unsure what a navigation does, ask what a full load would do.

## 2. What is swapped

- **`<head>`** becomes the new document's head children, in the new order (title, meta, canonical, stylesheets, inline styles, JSON-LD). An identical element is reused, never re-created, so a stylesheet shared by both pages is not downloaded or flashed again. New stylesheets and every module script of the new page are loaded before the swap, so the page never paints unstyled and a feature the first page did not use (a list, a form binding, a React island) is there when its component mounts. A head element that a live component added at runtime (a CSS-in-JS `<style>`, a React 19 hoisted `<link>`) is kept.
- **The body**: only the layout levels that changed are replaced. A nested layout whose own markup is the same in both pages stays live, with its DOM, component state, hydrated islands and inner scroll positions. If the root layout changes, the whole body is replaced and the attributes of `<html>` and `<body>` follow the new page.
- **Scroll**: the new page scrolls to its `#hash` target or to the top. Back and forward restore the position the entry had. A link to the URL already on screen loads it again (from the page cache while it is fresh, §5) without adding a history entry.
- **Focus** is reset the way a full load resets it.

## 3. Which clicks navigate

A plain primary-button click on an `<a href>` to the same origin (`http:` or `https:`). These are left to the browser: a click with Ctrl, Meta, Shift or Alt, a link with `target` other than `_self` or with `download`, a click that something already `preventDefault()`-ed, and a link that only changes the `#hash` of the current page. Forms are not intercepted: a `<form>` submits as before.

## 4. Opt-outs

| Attribute | On | Effect |
|---|---|---|
| `data-brust-reload` | a link, a region, `<html>` or `<body>` | Links inside get a normal full load, and are not prefetched. On `<html>` it turns SPA navigation off for the whole app. |
| `data-brust-prefetch="false"` | a link or a region | The links inside are not prefetched. They still navigate. |
| `data-brust-persist="<key>"` | any element | If the old and the new page both have an element with the same key, the live old element is moved into the new page and is never disposed (a playing video, an open chat widget). |
| `data-brust-once` | a classic `<script>` | The script runs on the first load of the tab only (an analytics loader), not again when a navigation brings it back. |
| `data-brust-cache="<seconds>"` | `<html>` | How long a fetched page stays fresh in the page cache (default 300). `0` turns the cache off. See §5. |
| `data-brust-prefetch-gap="<seconds>"` | `<html>` | The least time between two prefetches of the same URL (default 10). `0` prefetches on every hover. See §5. |
| `data-brust-progress="off"` | `<html>` | No progress bar. See §6. |
| `data-brust-transition="off"` | `<html>` | No page transition. See §7. |

There is no config key. The attribute is the opt-out.

A classic `<script>` in the head that is new to the page runs. After a whole-body swap (the root layout changed) every classic head script runs again, in order, as it would on a full load. That keeps a theme script that sets `<html class>` correct. A script in a kept layout does not run again.

## 5. Prefetch and the page cache

brust fetches a link's page when you show intent: after 65 ms of hover, on focus, or at once on `touchstart`. Prefetch is off when the browser asks to save data (`saveData`, or a `2g` connection) and for the opt-outs above. Prefetches fire no events. A link to the page you are on is not prefetched.

**The prefetch gap.** A page the cache does not keep (`no-store`, see below) would be fetched again by every hover, and again by the click. So brust remembers when each URL was last fetched, by a prefetch or by a navigation, kept or not, and a prefetch of a URL fetched less than 10 seconds ago does nothing. `<html data-brust-prefetch-gap="30">` sets the gap in seconds; `0` prefetches on every hover, as before. The gap holds back prefetches only: a click, `navigate()` and back/forward never wait for it, and a `no-store` page is still never shown from memory. A mutation through `@brust/core/client` and `clearNavigationCache()` clear the record with the cache, so the next hover fetches. The record holds the last 32 URLs.

Every fetched page, prefetched or navigated to, goes into a page cache in memory, one per tab:

- **Fresh for 5 minutes.** While a page is fresh, hovering its link again fetches nothing, and a click, `navigate()` or a link to it from anywhere shows it with zero requests. After 5 minutes it is fetched again.
- **Back and forward** show the cached page at any age, as the browser's back-forward cache does. A page that is not in the cache is fetched.
- A click during a prefetch waits for that same request.
- **Never cached**: a response with `Cache-Control: no-store`, any status of 400 or more, and a response that is not a brust page of this build. A page that must never be stale sends `no-store`.
- **Only `no-store` keeps a page out.** `private`, `no-cache`, `max-age=0` and `must-revalidate` (many hosts send `public, max-age=0, must-revalidate` on every page) do not: a page served that way is cached for its 5 minutes. A page that must never be shown from memory, such as an authenticated or sensitive one, sends `Cache-Control: no-store`: a loader sets it with `res.headers.set('Cache-Control', 'no-store')`, and on a layout it covers every page under it (see Response headers on the Loaders page, `/docs/loaders#headers`). A logout through `@brust/core/client` already clears the cache; any other logout calls `clearNavigationCache()`.
- It holds at most 32 pages; the least recently used goes first. The key is the URL without its `#hash`.
- `<html data-brust-cache="60">` sets the freshness in seconds. `data-brust-cache="0"` turns the cache off (a click during a prefetch still shares it).

**Mutations clear it.** A call through the actions client (`@brust/core/client`) with any method other than `GET` or `HEAD` clears the whole cache once it gets a response, so a page read after a mutation is never one from before it. If you change data another way (your own `fetch`, a form post), clear it yourself:

```ts
import { clearNavigationCache } from '@brust/core'

await fetch('/api/cart', { method: 'POST', body })
clearNavigationCache()
```

`clearNavigationCache()` does nothing on the server or on a page without the `nav` script.

A navigation served from the cache fires the same events (`click`, `load`, `success`, same `id` rules). Without a page transition it ends within the same task, so `data-brust-loading` is never painted. With one (§7) the old page is painted once more while it is set, for up to about 100 ms, so an indicator of your own should wait about 150 ms before it shows, as the built-in bar does (§6).

## 6. Events

Every event is a `CustomEvent` on `document`, bubbling, with a `detail`. A native component, a React island or a plain `<script>` listen the same way.

| Event | When | `detail` | Cancelable |
|---|---|---|---|
| `brust:nav:click` | A qualifying link click, before anything else. | `{ id, url, from, link }` | Yes. `preventDefault()` leaves the click to the browser (a full load). |
| `brust:nav:load` | The navigation starts: a link click, `navigate()` or back/forward. | `{ id, url, from, trigger }` | No |
| `brust:nav:success` | The new page is in place: swapped, history updated, scrolled and mounting. | `{ id, url, from, trigger, status }` | No |
| `brust:nav:error` | The navigation did not succeed. | `{ id, url, from, trigger, status, error, swapped }` | Yes |

- `trigger` is `'link'`, `'navigate'` or `'popstate'`. `from` is the URL that was on screen, `url` the final URL after redirects, `id` a per-tab counter that pairs the end of a navigation with its start.
- The order is `click` (link clicks only), `load`, then exactly one of `success` or `error`. A newer navigation supersedes the one in flight, and the superseded one fires nothing more. Its request is not aborted: the response still goes into the page cache.
- `success` fires when the new page is in the DOM, not when a page transition (§7) finishes animating.
- `error` has two cases. If the server answered with a brust page and a status of 400 or more (a `notFound()` 404, an error page), that page is swapped in as a full load would show it, with `swapped: true` and no default action. If nothing could be swapped (a network failure, a response that is not a brust document of this build, a failed module import), `swapped` is `false`, `error` holds the cause and the default action is a full load of `url`. Call `preventDefault()` to cancel that full load and show your own message.
- Only a response from the same build is swapped. After a deploy the first navigation does a full load and picks up the new runtime.

While a navigation loads, `<html>` carries `data-brust-loading` (set at `load`, removed at `success` or `error`).

### The progress bar

brust shows a 2 px line along the top of the viewport while the next page loads. It appears only when a navigation is still loading 150 ms after `load`, so a cached page or a fast server never shows it. It moves on its own toward about 80%, slowing as it goes, runs to the end at `success` or `error`, and fades out. It sits outside `<body>`, so no swap removes it.

- Colour: set `--brust-progress-color` (default `#2f7cf6`), for example `:root { --brust-progress-color: var(--accent); }`.
- Height: set `--brust-progress-height` (default `2px`).
- With `prefers-reduced-motion: reduce` it shows at 80% after the same 150 ms, without the movement, and goes at once at the end.
- To restyle it, write a rule for `div[data-brust-bar]` in your CSS: the element is a `<div data-brust-bar>` on `<html>`, and the built-in rules are one attribute selector each, in a `<style data-brust-bar>` added first in the head, so your rule wins.
- `<html data-brust-progress="off">` turns it off.

### A preloader of your own

To build your own indicator instead, turn the built-in one off with `<html data-brust-progress="off">` and read the [navigation store](#9-the-navigation-store) in a component. No `addEventListener`:

```tsx
import { navigation } from '@brust/core/navigation'
import { useStore } from '@brust/core/store/react'

export default function LoadingLine() {
  const nav = useStore(navigation)
  return <div className="line" data-state={nav.state} />
}
```

```css
.line { transform: scaleX(0); transform-origin: left; }
.line[data-state="loading"] { transform: scaleX(.8); transition: transform 8s cubic-bezier(.1, .8, .2, 1) .15s; }
```

Put it in the layout. It reads `state`, which is `idle` in every page's server markup, so the layout still renders the same on each page and is kept across navigations. The `.15s` delay keeps the line still on a navigation that is quick, such as one served from the cache. `nav.to` is the path being loaded, for a label.

The store is fed by the four events above. If you cannot use a store (plain script, no component), listen to them directly:

```ts
document.addEventListener('brust:nav:load', () => bar.start())
document.addEventListener('brust:nav:success', () => bar.done())
document.addEventListener('brust:nav:error', (e) => {
  bar.done()
  if (!e.detail.swapped) report(e.detail.error)
})
```

Or in CSS alone, with no JavaScript and no component:

```css
.bar { transform: scaleX(0); transform-origin: left; }
html[data-brust-loading] .bar { transform: scaleX(.8); transition: transform 8s cubic-bezier(.1, .8, .2, 1) .15s; }
```

The `.15s` delay keeps the bar still on a navigation that is quick, such as one served from the cache.

## 7. Page transitions

When the browser has the View Transitions API (`document.startViewTransition`), the swap runs inside a view transition. The default look is the browser's own cross-fade of the whole page (opacity only, about 250 ms). Pixels that are the same in both pages, such as a header or a sidebar that stays, do not visibly change, so only the content that changed fades. Nothing slides or scales.

- Everything slow happens before the transition starts: the fetch, the new page's scripts and stylesheets. The old page is frozen for about one frame, never for a network wait.
- The eager images the navigation swaps in (not `loading="lazy"`; a kept layout's are on screen already) get up to 100 ms to decode before the transition starts, so a hero image does not pop in after the fade. A page should mark its below-the-fold images `loading="lazy"`; those are not waited for.
- Back and forward use the same transition. A navigation that starts while a transition runs skips it and lands on the newer page.
- With `prefers-reduced-motion: reduce`, in a browser without the API, or with `<html data-brust-transition="off">`, the page swaps at once.
- Customise it with the standard CSS: `::view-transition-old(root)`, `::view-transition-new(root)`, or give your own elements a `view-transition-name`.

```css
::view-transition-old(root), ::view-transition-new(root) { animation-duration: 150ms; }
```

## 8. `navigate()`

```tsx
import { navigate } from '@brust/core'

navigate('/docs/store')                     // push an entry
await navigate('/search?q=brust', { replace: true }) // replace the current one
```

`navigate(url, { replace })` runs the same flow with `trigger: 'navigate'` and resolves after `success` or `error`. It is a browser function: call it from an event handler, an effect or an island. In server code, or while rendering on the server, it throws `navigate is browser-only`. If the page has no `nav` script (an older build, or a document brust did not render), `navigate` does `location.assign(url)`, or `location.replace(url)` with `replace: true`.

`clearNavigationCache()` (§5) is exported next to it. The types `NavigateOptions`, `NavTrigger`, `NavLoadDetail`, `NavSuccessDetail` and `NavErrorDetail` are exported from `@brust/core` for the event `detail` shapes.

## 9. The `navigation` store

The events are the low-level contract. For a component, brust ships one built-in store that mirrors them, so you read navigation state the way you read any other store, with no `addEventListener`:

```tsx
import { navigation } from '@brust/core/navigation'
import { useStore } from '@brust/core/store/react'

export default function NavSpinner() {
  const nav = useStore(navigation)
  return <div hidden={nav.state !== 'loading'}>Loading {nav.to}…</div>
}
```

It works in a native component and in a React island, and the first paint matches: the server renders `state: 'idle'` and `url` as the request's path and query, so hydration finds the markup it expects.

| Key | Type | Meaning |
|---|---|---|
| `state` | `'idle' \| 'loading'` | `'loading'` from `brust:nav:load` until `success` or `error` |
| `url` | `string` | path and query of the page on screen. Updated at `success`, and at `error` when the error page was swapped in |
| `to` | `string \| null` | path and query being loaded, else `null` |
| `trigger` | `'link' \| 'navigate' \| 'popstate' \| null` | of the current or last navigation |
| `status` | `number \| null` | HTTP status of the last navigation |
| `error` | `string \| null` | the message of the last failed navigation, cleared at the next `load`. A swapped 404 reads `HTTP 404` |
| `id` | `number` | the last navigation id (`0` before any) |

- It is a normal store: `navigation.state.subscribe(...)` works in a plain script and `navigation.snapshot()` gives plain values. Do not write it; the next event overwrites a write.
- `navigation` is a reserved store name. A `defineStore('navigation', …)` of your own that a component reads is a build error (`store-name-reserved`).
- A component that reads `url` depends on the URL, so a layout that reads it renders different markup on every page and is replaced on every navigation instead of kept. Read `to` and `state` in a layout, and `url` where a page-level component is fine.
- The module listens for the events once, when the first chunk that imports it loads. A navigation that is already loading at that moment shows `idle` until its `success`.

## 10. Stores across a navigation

A store that is already live keeps its client value across a navigation. The new page's store snapshot only seeds a store the tab has not used yet. This is the one deliberate exception to the rule above, and it matches React apps, where client store state survives a route change. See [Store](./store.md).

## 11. React islands

When a page leaves the document, its islands are unmounted and their effect cleanups run, as on a React route change. The islands of the new page hydrate when idle, as on a full load.
