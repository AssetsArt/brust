# SPA navigation (design, 2026-10-25)

owner: Detoro (lead, 22499151) · status: APPROVED by the human 2026-10-25 · plan: `docs/plans/2026-10-25-spa-navigation.md`

## 1. Intent

Today every link click in a brust v2 app reloads the whole document. The human asked for:

1. Link clicks that change the page without a full reload (SPA navigation).
2. Events an app can listen to (**click, load, success, error**) so it can build things like a
   preloader (a progress bar while the next page loads).

The brief was "design it fresh, the best and simplest", with Next.js, htmx, Astro, Remix and React
Router as reference points. This document is the result. The 0.1.x client router
(`/_brust/page/*` payloads) is NOT carried over; see §8.

## 2. The one rule

> **An SPA navigation shows exactly what a full load of that URL would show.** Only the JavaScript
> state that lives outside the page survives: live stores, module-level state, and elements the
> author marked `data-brust-persist`.

Every behaviour below follows from that rule. When a builder is unsure, they ask "what would a full
load do?" and do that.

## 3. How it works (the mechanism)

Same idea as Turbo Drive, Astro's `<ClientRouter>` and htmx `hx-boost`: **fetch the real HTML
document, swap it in place.**

1. A small standalone module, `nav`, is on every full brust document (also on pages that are all
   static and load no runtime). It listens for clicks on `document`.
2. On a qualifying click (§5.1) it calls `preventDefault()`, then `fetch(url)` for the normal HTML
   response. There is no new endpoint, no JSON payload, and no server change beyond emitting the
   `nav` script tag. The static target, Cloudflare and every adapter work unchanged, because they
   already serve that HTML.
3. It parses the response with `DOMParser`. If the response is not a brust document from the same
   build (§5.4), it falls back to a full load.
4. Before it touches the page, it loads everything the new page needs:
   - the new page's `data-brust-store` snapshot tags go into the document;
   - every module script of the new page (runtime core, feature modules, behavior chunks, `react`,
     React island chunks) is `import()`ed and awaited. This is runtime-split R35.6: "a newly navigated
     page may need features the first page did not load: load them before its components mount";
   - every new stylesheet is appended to `<head>` and awaited (load or error), so the page never
     paints unstyled.
5. Swap:
   - `<head>`: after the swap, the head's children are EXACTLY the new document's head children, in
     the new document's order. This covers `<title>`, `<meta>` (description, og:*, theme-color),
     `<link rel="canonical">`, stylesheets, inline `<style>`, JSON-LD and modulepreload links.
     Matching is by `outerHTML`: an old element identical to a new one is reused (moved into its new
     position, never re-created), so an unchanged stylesheet is neither re-downloaded nor flashed. A
     new element is inserted at its position. New stylesheets were already added and awaited in
     step 4, and only their position changes here. An old element with no identical new one is
     removed. Order matters because the stylesheet order is the cascade order: a page whose CSS order
     differs from the previous page's must cascade like a full load. A classic `<script>` that is
     new in the head runs, and a reused one does not run again. `document.title` follows from the
     new `<title>`;
   - the body: ONLY the layout levels that changed are replaced (§5.9, nested layouts). The
     levels above them stay live: their DOM nodes, component state, hydrated islands and inner
     scroll positions are untouched. When the root layout itself changed, the body's children are
     replaced in ONE `document.body.replaceChildren(...)` and the attributes of `<html>` and
     `<body>` are replaced by the new document's. Either way, the runtime's existing
     `MutationObserver` (`packages/runtime-dom/src/mount.ts` `startObserver`) disposes every
     removed instance and mounts every inserted one. The inserted ones are `late`, like a React
     client mount (this is the case F302 already probes);
   - `data-brust-persist="<key>"`: when the old and new bodies both have an element with the same
     key, the live old element replaces the new one before the swap, so it is moved and never
     disposed (a playing video, an open chat widget);
   - classic `<script>` elements of the new body (inline or `src`; not `type="module"`, not
     `type="application/json"`) are re-created so they run, in document order, as on a full load.
6. History and scroll: `pushState` (or `replaceState`, §5.3). Then scroll to the `#hash` target, or
   to the top. Back and forward run the same fetch-and-swap and restore the saved scroll position.
7. Fire the events (§4) at each step.

Concurrency: a new navigation aborts the one in flight (`AbortController`). A superseded navigation
fires no further events.

## 4. Events (the public contract)

Every event is a `CustomEvent` dispatched on `document`, bubbling, with a `detail`. They are plain
DOM events, so a native component, a React island, or a plain `<script>` can all listen
(`document.addEventListener('brust:nav:load', …)`). Names follow htmx and Astro (`ns:event`).

| Event | When | `detail` | Cancelable |
|---|---|---|---|
| `brust:nav:click` | A qualifying link click, before anything else. | `{ id, url, from, link }` | Yes. `preventDefault()` leaves the click to the browser (a normal full load). |
| `brust:nav:load` | The navigation starts: link click, `navigate()`, or back/forward. | `{ id, url, from, trigger }` with `trigger: 'link' \| 'navigate' \| 'popstate'` | No |
| `brust:nav:success` | The new page is in place: swapped, history updated, scrolled, and its components mounting (React islands still hydrate when idle, as on a full load). | `{ id, url, from, trigger, status }` | No |
| `brust:nav:error` | The navigation did not succeed. | `{ id, url, from, trigger, status, error, swapped }` | Yes, see below |

Rules:

- Order is always `click → load → (success | error)`. `click` fires for link clicks only. A
  navigation that is not superseded ends with **exactly one** `success` or `error`. `id` is a
  per-tab counter, so a listener can match the end of a navigation to its start.
- `url` is the final URL (after redirects). `from` is the URL that was on screen.
- `error` has two cases:
  - **The server answered with a brust page and status ≥ 400** (a `notFound()` 404, an error page).
    The page IS swapped in, as a full load would show it. `swapped: true`, `status` is set, and
    there is no default action.
  - **Nothing could be swapped**: a network failure, a response that is not a brust document of
    this build, a failed module import, or an exception during the swap. Then `swapped: false`,
    `error` holds the cause, and the **default action is a full load of `url`**, so the user still
    gets the page or the browser's own error screen. `preventDefault()` on the event cancels that
    full load (the app shows its own message).
- CSS hook, no JavaScript needed: while a navigation is loading, `<html>` carries
  `data-brust-loading` (set at `load`, removed at `success`/`error`). A preloader can be pure CSS:
  `html[data-brust-loading] .bar { … }`.

Example (goes into the docs page):

```ts
document.addEventListener('brust:nav:load', () => bar.start())
document.addEventListener('brust:nav:success', () => bar.done())
document.addEventListener('brust:nav:error', (e) => { bar.done(); if (!e.detail.swapped) report(e.detail.error) })
```

## 5. Details

### 5.1 Which clicks are intercepted

An `<a>` (or SVG `<a>`) with an `href`, where all of these hold:

- primary button, no Ctrl/Meta/Shift/Alt, and the event was not already `defaultPrevented` (a React
  island's own `onClick` that prevents default wins);
- same origin, `http:`/`https:`;
- no `target` other than `_self`, no `download`;
- neither the link nor any ancestor (up to and including `<html>`) has `data-brust-reload`;
- not a hash-only change on the current page (the browser scrolls; no fetch).

Opt-out is the attribute, nothing else: put it on a link, a region, or `<html>`/`<body>` to turn SPA
navigation off for the whole app. There is no config key.

Forms are NOT intercepted in this wave: a `<form>` submits as today.

### 5.2 Prefetch on intent

To make clicks feel instant, `nav` prefetches a qualifying link:

- after 65 ms of hover (`pointerenter`, cancelled on `pointerleave`), on `focusin`, or at once on
  `touchstart`;
- with `fetch(url, { priority: 'low', headers: { 'Sec-Purpose': 'prefetch' } })`;
- the response promise is held for up to 15 s and used at most once (by the click on that URL);
- not when `navigator.connection.saveData` is set or `effectiveType` is `2g`/`slow-2g`, and not when
  the link or an ancestor has `data-brust-prefetch="false"` or `data-brust-reload`.

A click that lands during a prefetch awaits that same response. Prefetches fire no events.

### 5.3 Programmatic navigation

`navigate(url: string, opts?: { replace?: boolean }): Promise<void>` is exported from `@brust/core`
(the browser entry, `packages/brust/src/browser.ts`; the server entry exports a version that throws
"navigate is browser-only"). It runs the same flow with `trigger: 'navigate'` and resolves after
`success` or `error`. It reaches the `nav` module through `globalThis[Symbol.for('brust.nav')]`
(the same cross-chunk pattern as `Symbol.for('brust.stores')`). If `nav` is absent, it calls
`location.assign(url)`.

A click on a link to the URL already on screen does a `replace` navigation (re-fetch, no new
history entry), as Turbo and React Router do.

### 5.4 Is it a brust document of this build?

The server emits the `nav` tag as
`<script type="module" src="/_brust/client/nav-<hex>.js" data-brust-nav data-brust-build="<id>">`.
`<id>` changes whenever `brust build` produces different output (a digest of the manifest is fine).
A fetched response is swapped only when it is `text/html` AND contains a `script[data-brust-nav]`
whose `data-brust-build` equals the current page's. Anything else is a full load (`error`,
`swapped: false`, default action). This also protects against deploy skew: after a new deploy, the
first navigation does a full load and picks up the new runtime instead of mixing two builds.

### 5.5 Stores

A store that is already live keeps its client state across a navigation. The new page's
`data-brust-store` snapshot only seeds a store the tab has not instantiated yet. This is the one
deliberate exception to §2, and it matches React apps, where client store state survives a route
change. `applyStoreSnapshot` (`packages/runtime-dom/src/store/registry.ts:86`, "reserved for the SPA
wave") is NOT wired. 0.1.x re-applied snapshots and rolled back live client state (memory
`spa-page-cache-prefetch`). The `docs/store.md:160` line is rewritten to say this.

### 5.6 React islands

An old island's React root must be unmounted when its host leaves the document (effects clean up,
like a React route change). Today `cancelIslands` only forgets pending hosts. The hydrate path must
keep the root and unmount it from the observer's dispose path.

### 5.7 Scroll and focus

- `history.scrollRestoration = 'manual'` once `nav` boots. The scroll position is kept in memory per
  history entry. Each entry gets an id in `history.state.brust`, the initial entry included, via
  `replaceState` at boot.
- Trap from 0.1.x: on `popstate`, `location` already points at the destination. Save the leaving
  entry's position against the id `nav` tracks itself, never one derived from `location`.
- After a swap, focus is reset the way a full load resets it (the old active element is gone). No
  extra focus management in this wave.

### 5.9 Nested layouts and multiple `<Outlet>` levels

This is the part 0.1.x got wrong twice. Its client put a page payload into the outlet, so a payload
that carried its own layout nested a whole page inside the old one. It also did a full reload
whenever a navigation crossed layouts. v2 does neither. Every navigation, between any two routes,
swaps in place and never reloads, and the result is the same DOM a full load would build.

**The chain.** A page is a chain of levels, root layout → … → inner layout → page. The server
renders it leaf-first (`Renderer::render_chain_into`, `crates/brust-core/src/render.rs:153`), and
each level's output becomes its parent's `__outlet`. So the server knows exactly where each level
starts and ends.

**Markers (server).** In production too, not only in `brust dev`, the server wraps every inner
level's output (`pos > 0`) in a pair of comments:

```
<!--brust-l:<levelId>:<shellHash>--> …that level's output… <!--/brust-l:<levelId>-->
```

The root level's `<levelId>:<shellHash>` goes on the `nav` script tag as `data-brust-root`. Comments
are used because they change nothing in layout or CSS: no wrapper element breaks a `main > article`
or a flex child selector. The closing comment repeats the id, so the client can never pair the
wrong two comments. This replaces the dev-only `<!--brust:<id>-->…<!--/brust-->` markers. The
devtools highlighter (`packages/brust/src/dev/devtools.ts:242,334`) moves to the new form, so there
is one marker scheme, not two.

**Shell hash.** `<shellHash>` is a hash of the level's OWN markup: its rendered output with its
child level's output (the `__outlet` string) left out. For the root level, `<head>…</head>` is left
out too, because the head is reconciled on its own (§3 step 5). It is computed inside
`render_chain_into`, before asset injection and before the F399 head hoist, so injected scripts and
hoisted titles never make two equal layouts look different. Any stable 64-bit hash is fine.

The hash is what makes keeping a layout SAFE. A layout's markup can depend on the URL: an active
nav link computed in its loader, a breadcrumb. When the hash is equal, the new server markup of that
level is byte-identical to the old one, so keeping the live DOM shows what a full load would show.
When it differs, that level is replaced.

**The algorithm (client).** It reads the live chain from the current document: the root from the
`nav` tag, then the `brust-l` comment pairs in nesting order. It reads the new chain from the parsed
response the same way.

1. If the root ids or root hashes differ, replace the whole body (§3 step 5) and stop.
2. Otherwise find the deepest level `k` such that, for every level `0..=k`, id AND hash are equal in
   both chains. The page level (the leaf) is never kept, so `k` is at most the level above the
   page.
3. Replace the nodes between the old chain's level `k+1` comment pair (both comments included) with
   the nodes between the new chain's level `k+1` pair, in one `Range`-based replacement (one
   mutation batch for the observer). The new nodes are imported from the parsed document. Nothing
   else in the body changes.

Examples. `/docs/a → /docs/b` under Root > Docs: the page level is replaced, and Root and Docs stay
live (if Docs' sidebar marks the active link in its markup, Docs' hash differs and Docs is replaced
too: correct, never stale). `/docs/a → /blog/x` under Root > Docs and Root > Blog: k = Root, so
Docs + page is replaced by Blog + page, with no reload. Two different root layouts: the whole body
is replaced, with no reload.

**Fail-safe rules (never a nested mess, never a wrong page).**

- A comment pair whose two comments are not siblings in the live DOM or in the parsed response
  cannot be used as a range. The HTML parser can split them: an outlet inside a `<p>` whose child
  starts a `<div>`, an outlet in a `<table>` (foster parenting), an `x-if`/`x-for` that moved
  nodes. That level counts as changed, so the swap happens one level higher, ultimately the
  whole body.
- A level the server does not mark (a React-tier level, rendered and hydrated as one island, gets
  no comment nodes inside it) is not keepable. The swap happens at the deepest marked, equal
  ancestor above it.
- A response with a missing or malformed chain (no `data-brust-root`, unbalanced comments) gets a
  whole-body swap, never a partial one.
- Body-end assets of the new page (module scripts, store snapshot tags) are handled by §3 step 4
  whatever level is swapped. A kept level's classic scripts do not run again. That is the one
  visible-behaviour difference from a full load, it matches how Next.js and Remix layouts behave,
  and it is documented.

**Keeping a URL-dependent layout alive** (later, not this wave): a layout whose markup depends on
the path (active links) is replaced on each navigation. Its hash changes, so this is correct, but
its state is lost. The way to keep it alive is to make the active state client-side: a later
`usePathname()` / `aria-current` helper that the compiler turns into a native binding, so the
server markup no longer depends on the URL. `data-brust-persist` is the tool for a single widget
today.

### 5.8 Where the code goes

- `packages/runtime-dom/src/nav/*.ts`: standalone. It imports nothing from the core, because it must
  run on pages without the core. It is built as its own content-hashed asset `client/nav-<hex>.js`,
  with a budget line in `docs/runtime-budget.json` (target ≤ 2.5 KB gzip).
- `crates/brust-core/src/manifest.rs` `Assets` gains `nav` (optional, so an older manifest still
  loads). `crates/brust-core/src/render.rs` `inject_document_assets_into` emits the tag on every
  full document. The tag goes BEFORE the `if !any_dynamic { return }` early exit, so all-static
  pages get it too; fragments get none. `render_chain_into` emits the `brust-l` level markers and
  shell hashes (§5.9). It is the one choke point the server, the static target and the adapters
  share (F392 used the same point).
- `packages/brust/src/build/*`: builds the asset and computes the build id.
- `packages/brust/src/browser.ts` + the server entry: `navigate`.
- Docs: a new `docs/navigation.md` (events table, opt-outs, the preloader example) and a website page.
  brust.dev dogfoods it.

## 6. Goals, non-goals, anti-goals

Goals: no full reload on link clicks; the four events with the contract in §4; works on every target
(server, static, Cloudflare, adapters) with no server endpoint; native pages and React islands both
correct after a navigation; prefetch on intent.

Non-goals (this wave): form submissions and actions (later wave); View Transitions (later, opt-in,
on top of the swap; 0.1.x lessons in memory `view-transitions-feature`); keeping a URL-dependent
layout alive through a client-side active-link helper (§5.9, later); fetching only the changed
level from the server (the client still fetches the full document and swaps the changed levels; a
partial response is a later byte optimisation); a built-in progress bar component (the events + `data-brust-loading` + a docs
example cover it); a React `useNavigation()` hook (can be built on the events later); a client-side
page cache for back/forward (each back/forward re-fetches; prefetch covers forward clicks).

Anti-goals (a failure even if it "works"): a navigated page that differs from a full load of the same
URL; mixed builds after a deploy; a page painted before its CSS or its runtime features; old
components left running (leaked effects, React roots); an event order that a preloader cannot rely
on; a new server endpoint or per-target code.

## 7. Acceptance (served Chromium tests, wired into `ci.yml`)

1. Native page A → B by link: no document reload (a `window` marker survives), URL, title and
   content equal a full load of B (same DOM snapshot of `<body>`). The `<head>` children equal a
   full load of B's, in order: A and B differ in title, meta description, canonical, and the order
   of two stylesheets. A stylesheet the two pages share is the same node and is not fetched twice.
   A site `<header>` with an active nav link shows B's active link.
2. Events: `click, load, success` in order with matching `id`; `data-brust-loading` present only
   between `load` and the end event.
3. 404 target: page swapped, `error` with `status: 404, swapped: true`, no full load.
4. Network failure (server killed or route aborted): `error` with `swapped: false`, then a full load;
   with `preventDefault()` there is no full load.
5. Page B needs a feature module page A did not load (A has no `x-for`, B has): B's list works.
6. A React island on A unmounts (effect cleanup runs) and B's island hydrates.
7. A live store keeps its client value from A to B. A store first used on B is seeded from B's
   snapshot.
8. Back/forward restores scroll. `#hash` links scroll to the target.
9. `data-brust-persist` element is the same node after the navigation.
10. Prefetch: hover then click = one request; `data-brust-prefetch="false"` = no prefetch.
11. Opt-outs: `data-brust-reload` on a link and on `<html>`; a modifier click; `target="_blank"`.
12. Deploy skew: a different `data-brust-build` in the response → full load.
13. `--target static` output: A → B works from the static files.
14. **Layout matrix, differential against a full load.** A fixture app with root layouts R1 and R2,
    inner layouts R1 > A, R1 > B, R1 > A > A2 (three levels), and A with a loader-computed active
    link (URL-dependent shell). Navigate every ordered pair of its pages (same layout, sibling
    layouts, up and down the depth, across roots, into and out of a 404). After each navigation:
    the body DOM equals a fresh full load of that URL (both settled, `data-brust-persist` nodes
    excluded); no layout appears twice (no nested page); there was no document reload; and a
    counter component in each layout that should be kept still holds its clicked value, while
    one in a replaced level is reset. Plus the fail-safe cases: an outlet inside `<p>` with a
    block child, and an outlet inside a `<table>`. Both fall back one level higher and still
    equal a full load.
15. Server: unit tests in `render.rs` for the markers and the hash. Two renders whose level markup
    differs only in the child have equal hashes, a one-byte change in a level's own markup changes
    its hash, and injected assets and the head do not change the root hash.
16. F302's SPA-navigation variant: a `useIsHydrated` consumer navigated to reads `true`. F301: the
    dev tripwire raises no false alarm on a navigation.
17. Runtime budget line for `nav` holds in CI.

## 8. Rejected alternatives (with the reason)

- **JSON/RSC payload per route (Next.js, Remix/React Router `.data`, brust 0.1.x `/_brust/page/*`).**
  It needs a server endpoint on every target (0.1.x had to export payload files for SSG), and a v2
  native component's template renders on the server only, so the client could not render a payload
  anyway. Full HTML gives one code path that every target already serves.
- **Always swapping the whole body** (Turbo, Astro). It is simpler, but every layout's state is
  lost on every navigation (a sidebar's scroll, a layout island's input), and the human asked for
  layouts that do not reload. Rejected in favour of §5.9. Whole-body swap remains the fallback.
- **Putting the page payload into "the" outlet** (0.1.x). It nested whole pages inside each other
  and reloaded across layouts. §5.9 matches levels by id and shell hash from the parsed full
  document, so a level can only ever replace the same level.
- **Morphing the DOM (idiomorph, Turbo 8 morphing).** The live DOM is owned by the runtime (bound
  signals, `x-if`/`x-for` clones, hydrated React), so a server-markup diff against it would fight
  live state. Replacing whole levels and keeping equal ones has no such conflict.
- **Trusting the layout id alone to keep a level** (Next.js keeps a layout by segment). In brust a
  layout's markup can depend on the URL through its loader, so an id match alone would show a stale
  active link. The shell hash closes that gap.
- **The Navigation API (`navigation.addEventListener('navigate')`).** Cleaner, but browser support
  is not universal yet. Click delegation + the History API work everywhere.
- **Opt-in links (`hx-boost`, a `<Link>` component).** Native components render plain `<a>`, so
  opt-in would mean touching every link. On by default, with a `data-brust-reload` opt-out, is less
  for the author to do and to get wrong.
- **Putting the router in the runtime core.** All-static pages load no core, so they could not
  navigate. `nav` is standalone.
- **Re-applying the new page's store snapshot to live stores.** It rolled back client state in 0.1.x.
- **A config key to turn it off.** The `data-brust-reload` attribute on `<html>` already does it,
  with no config plumbing on any target.

## 9. Risk ledger (what is known to be fragile)

- Module scripts must run in the order the server wrote them (core, features, chunks, react, react
  chunks). Await the `import()`s sequentially in that order, or prove that parallel import keeps the
  registration order the runtime relies on.
- When a store chunk reads its `data-brust-store` tag (`store/registry.ts:53`): if that happens at
  import time and not on first use, the new tags must be in the document before the imports (§3
  step 4 already says so). Verify; do not assume.
- The core calls `mount(document.body)` when it is first imported. On a page that had no core, that
  happens before the swap, and the observer then mounts the new body. Check that this does not
  mount the old body's hosts as not-`late`.
- `replaceChildren` on `<body>` is one mutation record. The observer disposes the removed nodes and
  mounts the added ones in the same callback, so the order must be dispose first, then mount (it
  is, in `startObserver`; keep it).
- Persisted elements are moved, not disposed: the observer sees them in `removedNodes` with
  `isConnected === true` and skips them. Verify that is what happens with a move inside one
  `replaceChildren`.
- Classic inline scripts that ran on page A run again on page B, if B has them too. That is
  full-load parity. Analytics snippets that guard against a double init are the author's job;
  document it.
- `history.replaceState` is rate-limited in Safari (about 100 calls per 30 s). Never call it from a
  scroll handler. Keep scroll positions in memory.
- Level markers are comments in a parent's `__outlet`. Anything that strips or reorders comments
  (an HTML minifier in an adapter, an author's `x-html`, a CDN "optimiser") breaks the chain, and
  the fail-safe rule then gives a whole-body swap: correct, but layouts not kept. The static target
  must not strip comments.
- The F399 head hoist and `ensure_doctype` run after the chain render: the hash must be computed
  on the chain output, not on the final document (§5.9). A test pins this (§7 item 15).
- A React-tier layout level is never kept (§5.9). If the coverage battery shows many apps with React
  layouts, keeping them is a separate design.
- The dev server's reload WebSocket (`/_brust/dev`) must survive a navigation. If its client script
  is in the body, it is re-run on every navigation; make sure that does not open a second socket.
