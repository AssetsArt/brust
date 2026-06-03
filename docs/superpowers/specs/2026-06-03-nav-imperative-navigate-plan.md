# Imperative `navigate()` + query-as-object — implementation plan

Spec: `2026-06-03-nav-imperative-navigate-design.md` · Branch: `feat/b6-dx-hardening`

Three tasks, strict sequence, TDD. No napi/Rust changes. Gate after each:
`bun run ci` (biome) + `bun run typecheck:treaty` + the touched test files.

## Spec coverage map

| Spec section | Task |
|---|---|
| Wiring §1 — `_navigator` slot + `registerNavigator` | Task 1 |
| API + `buildSearch`/`applyQuery` + merge + public `navigate()` + barrel export + tsconfig | Task 2 |
| Tests §1/§2/§3 | Task 1 (§3) + Task 2 (§1/§2) |
| Wiring §2/§3 — bootstrap mode param + register at boot | Task 3 |
| Tests §4 — bootstrap mode + fallback | Task 3 |

---

## Task 1 — `store.ts`: `_navigator` slot + `registerNavigator`

**File:** `runtime/navigation/store.ts`

### RED — `runtime/navigation/store.test.ts` (add; or extend if it exists)
```ts
import { expect, test } from 'bun:test'
import { __resetNavForTest, registerNavigator, _getNavigator } from './store.ts'

test('registerNavigator stores the fn; _getNavigator returns it; reset clears it', () => {
  __resetNavForTest()
  expect(_getNavigator()).toBeNull()
  const fn = async () => {}
  registerNavigator(fn)
  expect(_getNavigator()).toBe(fn)
  __resetNavForTest()
  expect(_getNavigator()).toBeNull()
})
```
Run `bun test runtime/navigation/store.test.ts` → fails (exports missing).

### GREEN
- In `NavInternal` (after the callback sets), add:
  `_navigator: ((url: URL, replace: boolean) => Promise<void>) | null`
- In `createNav()` return literal, add: `_navigator: null,`
- Add exports:
```ts
/** Register the SPA navigator implementation (bootstrap's swap). Last-write-wins;
 * re-registration with the same closure (HMR / multiple chunks) is idempotent in
 * effect since it's a single ref over the one singleton. */
export function registerNavigator(fn: (url: URL, replace: boolean) => Promise<void>): void {
  store()._navigator = fn
}
/** @internal — the registered navigator, or null when no islands bootstrap loaded. */
export function _getNavigator(): ((url: URL, replace: boolean) => Promise<void>) | null {
  return store()._navigator
}
```
(`__resetNavForTest` already drops the whole singleton → `_navigator` clears for free.)

Gate: `bun run typecheck:treaty` (store.ts is in the treaty files list) + the test green.
Commit: `feat(nav): registerNavigator slot on the nav singleton (B7)`

---

## Task 2 — `navigate.ts`: query serialization + public `navigate()` + exports

**Files:** NEW `runtime/navigation/navigate.ts`, `runtime/navigation/index.ts`,
`runtime/tsconfig.typecheck.json`, NEW `runtime/navigation/navigate.test.ts`.

### RED — `runtime/navigation/navigate.test.ts`
```ts
import { afterEach, expect, test } from 'bun:test'
import { __resetNavForTest, registerNavigator } from './store.ts'
import { buildSearch, navigate } from './navigate.ts'

afterEach(() => __resetNavForTest())

test('buildSearch: empty → "", coercion, arrays, null/undefined skip, empty array', () => {
  expect(buildSearch({})).toBe('')
  expect(buildSearch({ a: 1, b: true, c: 'x' })).toBe('?a=1&b=true&c=x')
  expect(buildSearch({ t: ['fire', 'water'] })).toBe('?t=fire&t=water')
  expect(buildSearch({ a: null, b: undefined, c: 'y' })).toBe('?c=y')
  expect(buildSearch({ a: [] })).toBe('')
})

test('navigate: calls registered navigator with built URL + replace flag', async () => {
  const calls: Array<{ url: string; replace: boolean }> = []
  registerNavigator(async (url, replace) => { calls.push({ url: url.pathname + url.search, replace }) })
  await navigate('/search', { query: { q: 'pikachu', page: 2 }, replace: true })
  expect(calls).toHaveLength(1)
  expect(calls[0]!.replace).toBe(true)
  // assert via parsed params, not string order
  const u = new URL('http://x' + calls[0]!.url)
  expect(u.pathname).toBe('/search')
  expect(u.searchParams.get('q')).toBe('pikachu')
  expect(u.searchParams.get('page')).toBe('2')
})

test('navigate: option query MERGES over an existing path query (replace key, keep others)', async () => {
  let got: URL | undefined
  registerNavigator(async (url) => { got = url })
  await navigate('/x?a=1&b=2', { query: { a: 9 } })
  expect(got!.searchParams.get('a')).toBe('9')   // replaced
  expect(got!.searchParams.get('b')).toBe('2')   // preserved
})

test('navigate: null option value deletes an existing path query key', async () => {
  let got: URL | undefined
  registerNavigator(async (url) => { got = url })
  await navigate('/x?a=1', { query: { a: null } })
  expect(got!.searchParams.has('a')).toBe(false)
})
```
This file needs `location.href` to construct `new URL(path, location.href)`. If
`bun:test` lacks a global `location`, set a minimal one in the file:
`;(globalThis as any).location ??= { href: 'http://localhost/' }` at top (only if
absent — don't clobber a real harness). Run → fails (navigate.ts missing).

### GREEN — `runtime/navigation/navigate.ts`
```ts
// runtime/navigation/navigate.ts — public imperative SPA navigation for
// brustjs/navigation. DOM-free at import (touches location/history only at call
// time, like active-nav.ts); delegates the actual swap to the navigator bootstrap
// registers, so this module never imports DOM/island code.
import { _getNavigator } from './store.ts'

export type QueryValue = string | number | boolean
export type QueryInit = Record<
  string,
  QueryValue | null | undefined | ReadonlyArray<QueryValue>
>
export interface NavigateOptions {
  query?: QueryInit
  replace?: boolean
}

/** Apply a QueryInit onto `params`: each key REPLACES all existing occurrences
 * (delete-then-append); null/undefined omit the key; arrays expand to repeated
 * keys; number/boolean coerce via String(). Shared by buildSearch + navigate. */
function applyQuery(params: URLSearchParams, query: QueryInit): void {
  for (const key of Object.keys(query)) {
    const v = query[key]
    params.delete(key)
    if (v === null || v === undefined) continue
    if (Array.isArray(v)) {
      for (const item of v) params.append(key, String(item))
    } else {
      params.append(key, String(v as QueryValue))
    }
  }
}

/** Serialize a query object to a `?...` string (or '' when empty). Pure, DOM-free. */
export function buildSearch(query: QueryInit): string {
  const params = new URLSearchParams()
  applyQuery(params, query)
  const s = params.toString()
  return s ? `?${s}` : ''
}

/** Programmatic SPA navigation. Builds the target URL (resolving `path` against
 * the current location, merging `options.query` over any query already in `path`)
 * then delegates to the registered navigator (full SPA swap + nav-state lifecycle,
 * identical to a link click). With no navigator registered (no islands bootstrap),
 * falls back to a full-document load so the call still navigates. */
export async function navigate(path: string, options?: NavigateOptions): Promise<void> {
  const url = new URL(path, location.href)
  if (options?.query) applyQuery(url.searchParams, options.query)
  const nav = _getNavigator()
  if (nav) {
    await nav(url, options?.replace ?? false)
  } else {
    location.assign(url.href)
  }
}
```

- `runtime/navigation/index.ts` — add:
```ts
export { navigate, buildSearch } from './navigate.ts'
export type { NavigateOptions, QueryInit, QueryValue } from './navigate.ts'
```
- `runtime/tsconfig.typecheck.json` — add `"navigation/navigate.ts"` to the `files` array.

Gate: `bun test runtime/navigation/navigate.test.ts` green; `bun run typecheck:treaty`
(now type-checks navigate.ts); `bun run ci`.
Commit: `feat(nav): public navigate() + buildSearch query-object serialization (B7)`

**BLOCKED fallback:** if `bun:test` has no `location` and the `??=` stub interferes,
move the registered-spy navigate cases into `bootstrap.test.ts` (happy-dom harness)
and keep only `buildSearch` (pure) in navigate.test.ts. Don't weaken assertions.

---

## Task 3 — `bootstrap.ts`: mode param + register at boot

**Files:** `runtime/islands/bootstrap.ts`, `runtime/islands/bootstrap.test.ts`.

### RED — extend `bootstrap.test.ts` (has happy-dom harness)
Add (the harness installs `globalThis.history`/`location`):
```ts
test('navigate mode: replace → replaceState, none → no history write, push → pushState', async () => {
  __resetNavForTest()
  document.body.innerHTML = '<main></main>'
  ;(globalThis as Record<string, unknown>).fetch = mock(async () => ({
    ok: true, json: async () => ({ html: '<p>x</p>', title: 'T' }),
  }))
  const push = mock(() => {}); const replace = mock(() => {})
  ;(globalThis.history as unknown as Record<string, unknown>).pushState = push
  ;(globalThis.history as unknown as Record<string, unknown>).replaceState = replace
  await navigate(new URL('http://localhost/a'), 'push')
  expect(push).toHaveBeenCalledTimes(1); expect(replace).toHaveBeenCalledTimes(0)
  await navigate(new URL('http://localhost/b'), 'replace')
  expect(replace).toHaveBeenCalledTimes(1)
  await navigate(new URL('http://localhost/c'), 'none')
  expect(push).toHaveBeenCalledTimes(1) // unchanged by 'none'
})

test('public navigate() falls back to location.assign when no navigator registered', async () => {
  __resetNavForTest()
  const assign = mock(() => {})
  ;(globalThis.location as unknown as Record<string, unknown>).assign = assign
  const { navigate: publicNavigate } = await import('../navigation/navigate.ts')
  await publicNavigate('/fallback', { query: { a: 1 } })
  expect(assign).toHaveBeenCalledTimes(1)
  expect(String(assign.mock.calls[0]![0])).toContain('/fallback?a=1')
})
```
Run → the mode test fails (signature still `push: boolean`); the existing
`navigate(new URL(...), true)` test also fails to typecheck after the change — that's
the signal to update it in GREEN.

### GREEN — `runtime/islands/bootstrap.ts`
1. Line 19 import: `import { __navStart, __navCommit, __navError, __navInit, registerNavigator } from '../navigation/store.ts'`
2. Signature (~210): `export async function navigate(url: URL, mode: 'push' | 'replace' | 'none'): Promise<void>`
3. History write (~232) — replace `if (push) history.pushState({}, '', url.href)` with:
```ts
if (mode === 'push') history.pushState({}, '', url.href)
else if (mode === 'replace') history.replaceState({}, '', url.href)
```
4. Call sites: click (~258) `navigate(new URL(a.href, location.href), 'push')`;
   popstate (~261) `navigate(new URL(location.href), 'none')`.
5. Register at boot — inside `if (typeof document !== 'undefined') {` BEFORE the
   `readyState` branch (so it's available immediately, not gated on DOMContentLoaded):
```ts
  registerNavigator((url, replace) => navigate(url, replace ? 'replace' : 'push'))
```
6. Update the EXISTING bootstrap test calls `navigate(new URL(...), true)` → `'push'`.

Gate: `bun test runtime/islands/bootstrap.test.ts` green (incl. existing tests);
`bun run typecheck:treaty`; `bun run ci`.
Commit: `feat(nav): bootstrap navigate mode (push/replace/none) + register navigator at boot (B7)`

---

## Acceptance recap (Phase 6 gate)
- `import { navigate } from 'brustjs/navigation'`; `navigate('/p',{query,replace})`
  → SPA swap + nav-state lifecycle (no full reload) when bootstrap loaded; query
  object serialized + merged per rules; `replace` → replaceState; no-bootstrap →
  location.assign.
- Existing nav/bootstrap tests stay green; `buildSearch` pure + DOM-free.
- Gates: biome, typecheck:treaty, `bun test runtime/`. Manual smoke: pokedex console
  `navigate('/type-chart')` → SPA swap + `useNav()` phase transition.
