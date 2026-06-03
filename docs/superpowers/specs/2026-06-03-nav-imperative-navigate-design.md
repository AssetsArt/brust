# Imperative `navigate()` + query-as-object for `brustjs/navigation` — design

**Status:** approved (brainstormed 2026-06-03) · **Branch:** `feat/b6-dx-hardening`

## Goal

Add a public, programmatic SPA navigation function to `brustjs/navigation` so TS
code (event handlers, post-action redirects, etc.) can change the page without a
user clicking an `<a>`. Today SPA navigation is triggered only by anchor clicks
and `popstate` (`runtime/islands/bootstrap.ts:258,261`); the public
`brustjs/navigation` surface is read/observe-only (`nav`, `getNavState`,
`subscribe`, `onBeforeNavigate/onNavigate/onNavigateError`, `installActiveNav`,
`useNav`). The new `navigate()` also accepts the query string as an object.

## API surface (`brustjs/navigation`)

```ts
export function navigate(path: string, options?: NavigateOptions): Promise<void>

export interface NavigateOptions {
  /** Query params appended to `path`. Serialized via buildSearch (see below). */
  query?: QueryInit
  /** history.replaceState instead of pushState (no new history entry). Default false. */
  replace?: boolean
}

export type QueryValue = string | number | boolean
export type QueryInit = Record<
  string,
  QueryValue | null | undefined | ReadonlyArray<QueryValue>
>
```

Example:
`navigate('/search', { query: { q: 'pikachu', page: 2, type: ['fire', 'water'] } })`
→ SPA-navigates to `/search?q=pikachu&page=2&type=fire&type=water`.

### `buildSearch(query: QueryInit): string` — pure, DOM-free, unit-testable

- Returns `''` for an empty/no-key result, else `'?'` + encoded params.
- `null` / `undefined` values are **skipped** (the key is omitted entirely).
- `number` / `boolean` → `String(v)` (`2` → `"2"`, `true` → `"true"`).
- `ReadonlyArray<QueryValue>` → one repeated key per element, in array order
  (`type: ['a','b']` → `type=a&type=b`). An empty array emits no key.
- Encoding uses `URLSearchParams` (RFC 3986 form-encoding; spaces → `+`, which is
  consistent with the rest of brust's query handling).
- Key order follows `Object.keys(query)` insertion order; within a key, array
  order. Deterministic for tests.

### Query merge with an existing query in `path`

If `path` already contains a `?...`, the option `query` is **merged on top**:
- The base params come from `path`'s own query string.
- For each key in the `query` object, that key's existing base values are
  **removed**, then the object's value(s) are appended. (i.e. the option key
  REPLACES the base key, it does not duplicate.) Keys present only in the base are
  preserved; keys present only in the object are added.
- `null`/`undefined` in the object still means "omit" — and because the base key
  was removed first, passing `{ q: null }` against `path='/x?q=1'` **deletes** `q`.

This is implemented by parsing `path`'s query into `URLSearchParams`, then
`params.delete(k)` + `params.append(k, …)` per object key (skipping null/undef
after the delete).

## High-level architecture — registered navigator (layering-clean)

`navigation/store.ts` is deliberately DOM-free *at import* (it imports no web-API
module; it only touches `globalThis` at call time). The SPA swap implementation
(`fetch /_brust/page`, swap `<main>`, unmount/hydrate islands) lives in the
DOM/islands layer `bootstrap.ts:navigate`, which already *depends on* navigation
(it imports the `__nav*` lifecycle mutators). The public `navigate()` must reuse
that swap, not reimplement it — so we invert control via a registration handle
instead of importing bootstrap into navigation (which would pull DOM/island code
into the DOM-free entry and break the `typecheck:treaty` isolation + SSR import
safety).

1. **`NavInternal` gains a `_navigator` slot** (`store.ts`):
   `_navigator: ((url: URL, replace: boolean) => Promise<void>) | null`, created
   `null`. Exported `registerNavigator(fn)` sets it on the singleton; an exported
   getter (or `navigate()` reading the singleton directly) consumes it.
2. **`bootstrap.ts` registers at boot.** Where it currently installs the click +
   popstate interceptors, it also calls `registerNavigator((url, replace) =>
   navigate(url, replace ? 'replace' : 'push'))`.
3. **`bootstrap.navigate` mode param.** Its `push: boolean` becomes
   `mode: 'push' | 'replace' | 'none'`. The history write (currently `if (push)
   history.pushState(...)`) switches: `push` → `pushState`, `replace` →
   `replaceState`, `none` → no history write. Three call sites updated:
   click → `'push'`, popstate → `'none'`, registered navigator → `'push'`/`'replace'`.
4. **Public `navigate()` (`navigation/navigate.ts`)**: builds the final path
   string (`path`'s pathname/base + merged `buildSearch`), resolves
   `new URL(finalPath, location.href)`, then:
   - if a navigator is registered → `await registered(url, !!options?.replace)`
     (full SPA swap + nav-state lifecycle).
   - else (bootstrap not loaded — a page with no islands/SPA runtime) → fallback
     `location.assign(url.href)` (full document load) so the call still navigates.

Because the registered navigator IS `bootstrap.navigate`, every programmatic
navigation flows through `__navStart`/`__navCommit`/`__navError` exactly like a
click — so `useNav()`, `nav.*`, `subscribe`, and the lifecycle hooks update
identically. No change to the observe side.

## File structure

| File | Change |
|---|---|
| `runtime/navigation/navigate.ts` | NEW — `navigate()`, `buildSearch()`, `NavigateOptions`/`QueryInit`/`QueryValue` types |
| `runtime/navigation/store.ts` | `_navigator` slot in `NavInternal` + `createNav`; `registerNavigator(fn)`; a `_getNavigator()`/internal accessor; reset clears it |
| `runtime/navigation/index.ts` | re-export `navigate`, `NavigateOptions`, `QueryInit`, `QueryValue` |
| `runtime/islands/bootstrap.ts` | `navigate(url, mode)` signature; 3 call-site updates; `registerNavigator(...)` at boot |

## Tests

1. **`buildSearch` unit (`navigation/navigate.test.ts`):** empty → `''`; string/number/boolean
   coercion; array → repeated keys; null/undefined skipped; empty array → no key;
   key+array ordering deterministic; special chars encoded.
2. **`navigate` unit (same file, DOM-free with a registered spy):** register a spy
   navigator via `registerNavigator`; assert `navigate('/x', { query:{a:1}, replace:true })`
   calls the spy with the right `URL` (`/x?a=1`) and `replace=true`; assert the
   merge case (`navigate('/x?a=1&b=2',{query:{a:9}})` → `/x?a=9&b=2`); assert
   `{ a: null }` against `?a=1` deletes `a`. Use `__resetNavForTest()` between.
   For the fallback path, assert that with NO navigator registered it does not
   throw and (if feasibly stubbable) calls `location.assign` — otherwise cover the
   "registered wins" branch and leave fallback to integration.
3. **`store.ts` unit:** `registerNavigator` sets the slot on the singleton;
   `__resetNavForTest()` clears it (next access null).
4. **bootstrap mode unit (extend existing bootstrap tests if present):** `'replace'`
   → `history.replaceState`, `'none'` → no history write, `'push'` → `pushState`
   (mock history; the existing bootstrap test harness shows the pattern).
5. **Integration smoke (manual, Phase 6):** in pokedex (or fixture), call
   `navigate('/type-chart')` from the console / a button and confirm SPA swap +
   `useNav()` phase transition, no full reload.

## Acceptance criteria

- `import { navigate } from 'brustjs/navigation'` then `navigate('/p', { query })`
  performs an SPA navigation (no full reload) when the islands bootstrap is loaded,
  driving `useNav()`/`nav.*`/hooks exactly like a link click.
- Query object serializes per `buildSearch` rules; merges with an existing `path`
  query (object key replaces base key; `null`/`undefined` deletes/omits).
- `replace: true` → no new history entry.
- With no bootstrap loaded, `navigate()` falls back to a full-document load (no
  throw).
- Observe side unchanged: existing nav tests stay green; `buildSearch` is pure and
  DOM-free (passes `typecheck:treaty`).
- Gates green: biome, typecheck:treaty, `bun test runtime/`.

## Known limitations / non-goals

- **No scroll-restoration options** (bootstrap's existing `scrollTo(0,0)` applies).
- **`navigate` is NOT added to `useNav()`'s return** — standalone import only
  (ergonomics choice; functionality is identical either way).
- **No relative-path resolution** beyond `new URL(path, location.href)` (so `'./x'`
  / `'../x'` resolve against the current location, as the browser would).
- **No navigation cancellation API** from `navigate()` — `onBeforeNavigate` already
  observes transitions; a veto/guard API is out of scope.
- **No SSR/server use** — `navigate()` is a client action; it reads
  `location`/`history` at call time (module stays DOM-free at import).

## Open questions resolved at plan-time

- **Where `registerNavigator` lives:** `store.ts` (owns the singleton). `navigate.ts`
  imports the accessor from `store.ts`; bootstrap imports `registerNavigator` from
  the navigation barrel (same as it imports `__nav*`).
- **Pure helper boundary:** `buildSearch` takes only `QueryInit` and returns a
  string — no `location` access — so it unit-tests without a DOM and the URL
  resolution (`new URL(..., location.href)`) stays in `navigate()`.
