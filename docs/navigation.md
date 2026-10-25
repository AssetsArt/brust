# Navigation: SPA links, events and `navigate()`

A link click in a brust app does not reload the page. brust fetches the real HTML of the target URL and swaps it in place. The result is the same page a full load of that URL would show, and the browser never leaves the document. A page that cannot be swapped is loaded the normal way, so a link always works.

You write nothing for this. Every full document carries a small `nav` script (`<script type="module" src="/_brust/client/nav-<hash>.js" data-brust-nav …>`), also pages that are all static and load no runtime. `brust build --target static` output has it too, so a static site navigates the same way.

## 1. The one rule

> A navigation shows exactly what a full load of that URL would show. Only JavaScript state that lives outside the page survives: live stores, module-level state, and elements you marked `data-brust-persist`.

When you are unsure what a navigation does, ask what a full load would do.

## 2. What is swapped

- **`<head>`** becomes the new document's head children, in the new order (title, meta, canonical, stylesheets, inline styles, JSON-LD). An identical element is reused, never re-created, so a stylesheet shared by both pages is not downloaded or flashed again. New stylesheets and every module script of the new page are loaded before the swap, so the page never paints unstyled and a feature the first page did not use (a list, a form binding, a React island) is there when its component mounts. A head element that a live component added at runtime (a CSS-in-JS `<style>`, a React 19 hoisted `<link>`) is kept.
- **The body**: only the layout levels that changed are replaced. A nested layout whose own markup is the same in both pages stays live, with its DOM, component state, hydrated islands and inner scroll positions. If the root layout changes, the whole body is replaced and the attributes of `<html>` and `<body>` follow the new page.
- **Scroll**: the new page scrolls to its `#hash` target or to the top. Back and forward restore the position the entry had. A link to the URL already on screen re-fetches it without adding a history entry.
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

There is no config key. The attribute is the opt-out.

A classic `<script>` in the head that is new to the page runs. After a whole-body swap (the root layout changed) every classic head script runs again, in order, as it would on a full load. That keeps a theme script that sets `<html class>` correct. A script in a kept layout does not run again.

## 5. Prefetch

brust fetches a link's page when you show intent: after 65 ms of hover, on focus, or at once on `touchstart`. The click then uses that response. A prefetched response is held for 15 seconds and used once. Prefetch is off when the browser asks to save data (`saveData`, or a `2g` connection) and for the opt-outs above. Prefetches fire no events.

## 6. Events

Every event is a `CustomEvent` on `document`, bubbling, with a `detail`. A native component, a React island or a plain `<script>` listen the same way.

| Event | When | `detail` | Cancelable |
|---|---|---|---|
| `brust:nav:click` | A qualifying link click, before anything else. | `{ id, url, from, link }` | Yes. `preventDefault()` leaves the click to the browser (a full load). |
| `brust:nav:load` | The navigation starts: a link click, `navigate()` or back/forward. | `{ id, url, from, trigger }` | No |
| `brust:nav:success` | The new page is in place: swapped, history updated, scrolled and mounting. | `{ id, url, from, trigger, status }` | No |
| `brust:nav:error` | The navigation did not succeed. | `{ id, url, from, trigger, status, error, swapped }` | Yes |

- `trigger` is `'link'`, `'navigate'` or `'popstate'`. `from` is the URL that was on screen, `url` the final URL after redirects, `id` a per-tab counter that pairs the end of a navigation with its start.
- The order is `click` (link clicks only), `load`, then exactly one of `success` or `error`. A newer navigation aborts the one in flight, and the aborted one fires nothing more.
- `error` has two cases. If the server answered with a brust page and a status of 400 or more (a `notFound()` 404, an error page), that page is swapped in as a full load would show it, with `swapped: true` and no default action. If nothing could be swapped (a network failure, a response that is not a brust document of this build, a failed module import), `swapped` is `false`, `error` holds the cause and the default action is a full load of `url`. Call `preventDefault()` to cancel that full load and show your own message.
- Only a response from the same build is swapped. After a deploy the first navigation does a full load and picks up the new runtime.

While a navigation loads, `<html>` carries `data-brust-loading` (set at `load`, removed at `success` or `error`).

### A preloader

```ts
document.addEventListener('brust:nav:load', () => bar.start())
document.addEventListener('brust:nav:success', () => bar.done())
document.addEventListener('brust:nav:error', (e) => {
  bar.done()
  if (!e.detail.swapped) report(e.detail.error)
})
```

Or in CSS alone, with no JavaScript:

```css
.bar { transform: scaleX(0); transform-origin: left; }
html[data-brust-loading] .bar { transform: scaleX(.8); transition: transform 8s cubic-bezier(.1, .8, .2, 1); }
```

## 7. `navigate()`

```tsx
import { navigate } from '@brust/core'

navigate('/docs/store')                     // push an entry
await navigate('/search?q=brust', { replace: true }) // replace the current one
```

`navigate(url, { replace })` runs the same flow with `trigger: 'navigate'` and resolves after `success` or `error`. It is a browser function: call it from an event handler, an effect or an island. In server code, or while rendering on the server, it throws `navigate is browser-only`. If the page has no `nav` script (an older build, or a document brust did not render), `navigate` does `location.assign(url)`, or `location.replace(url)` with `replace: true`.

The types `NavigateOptions`, `NavTrigger`, `NavLoadDetail`, `NavSuccessDetail` and `NavErrorDetail` are exported from `@brust/core` for the event `detail` shapes.

## 8. Stores across a navigation

A store that is already live keeps its client value across a navigation. The new page's store snapshot only seeds a store the tab has not used yet. This is the one deliberate exception to the rule above, and it matches React apps, where client store state survives a route change. See [Store](./store.md).

## 9. React islands

When a page leaves the document, its islands are unmounted and their effect cleanups run, as on a React route change. The islands of the new page hydrate when idle, as on a full load.
