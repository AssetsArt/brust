# Navigation state — implementation plan (TDD)

Spec: `2026-06-03-navigation-state-design.md`. Branch: `feat/navigation-state`. No Rust changes. Each task is red→green→refactor; commit at the end of each.

## Spec coverage table

| Spec section | Task |
|---|---|
| `store.ts` signal singleton + lifecycle hooks + subscribe/onBefore/onNavigate/onError | T1 |
| `active-nav.ts` active-link updater + html phase attr (two effects) | T2 |
| `brustjs/navigation` export + package.json + tsc gate | T3 |
| bootstrap.ts wiring + export navigate + extend bootstrap.test.ts | T4 |
| pokedex AppLayout `data-brust-active-nav` + app.css loading bar | T5 |
| Acceptance criteria 1–5 (full verify + dev smoke) | T6 |

Baseline before starting (record): `bun run typecheck:treaty` exit 0; `bun test runtime/` green count.

---

## T1 — `runtime/navigation/store.ts` + `store.test.ts`

**RED** — write `runtime/navigation/store.test.ts` first. DOM-free (no happy-dom needed). Reset the singleton between tests.

```ts
// runtime/navigation/store.test.ts
import { test, expect, beforeEach } from 'bun:test'
import {
  nav,
  getNavState,
  subscribe,
  onBeforeNavigate,
  onNavigate,
  onNavigateError,
  __navStart,
  __navCommit,
  __navError,
  __navInit,
  __resetNavForTest,
} from './store.ts'

beforeEach(() => __resetNavForTest())

test('__navInit sets path/search, idle phase, null from/to/error', () => {
  __navInit('/a', '?x=1')
  expect(getNavState()).toEqual({
    path: '/a', search: '?x=1', phase: 'idle', error: null, from: null, to: null,
  })
})

test('__navStart sets loading, from=current path, to=target, fires onBeforeNavigate', () => {
  __navInit('/a', '')
  const seen: Array<{ from: string; to: string }> = []
  onBeforeNavigate((e) => seen.push(e))
  __navStart('/b', '?q=1')
  const s = getNavState()
  expect(s.phase).toBe('loading')
  expect(s.from).toBe('/a')
  expect(s.to).toBe('/b')
  expect(seen).toEqual([{ from: '/a', to: '/b' }])
})

test('__navCommit commits path/search, success phase, clears to, fires onNavigate', () => {
  __navInit('/a', '')
  __navStart('/b', '?q=1')
  const seen: Array<string> = []
  onNavigate((e) => seen.push(e.path))
  __navCommit('/b', '?q=1')
  const s = getNavState()
  expect(s.path).toBe('/b')
  expect(s.search).toBe('?q=1')
  expect(s.phase).toBe('success')
  expect(s.to).toBe(null)
  expect(s.error).toBe(null)
  expect(seen).toEqual(['/b'])
})

test('__navError sets error phase + error, clears to, fires onNavigateError', () => {
  __navInit('/a', '')
  __navStart('/b', '')
  const seen: Array<{ to: string; error: Error }> = []
  onNavigateError((e) => seen.push(e))
  const err = new Error('boom')
  __navError('/b', err)
  const s = getNavState()
  expect(s.phase).toBe('error')
  expect(s.error).toBe(err)
  expect(s.to).toBe(null)
  expect(seen).toEqual([{ to: '/b', error: err }])
})

test('subscribe fires on each transition and unsubscribes', () => {
  __navInit('/a', '')
  const phases: string[] = []
  const unsub = subscribe((s) => phases.push(s.phase))
  __navStart('/b', '')
  __navCommit('/b', '')
  unsub()
  __navStart('/c', '')
  expect(phases).toEqual(['loading', 'success']) // no third entry after unsub
})

test('nav signals are the shared singleton (reactive reads)', () => {
  __navInit('/a', '')
  expect(nav.path()).toBe('/a')
  __navCommit('/z', '')
  expect(nav.path()).toBe('/z')
})

test('onBeforeNavigate unsubscribe stops delivery', () => {
  __navInit('/a', '')
  let n = 0
  const off = onBeforeNavigate(() => { n++ })
  __navStart('/b', '')
  off()
  __navStart('/c', '')
  expect(n).toBe(1)
})
```

**GREEN** — `runtime/navigation/store.ts`:

```ts
// runtime/navigation/store.ts
// Client-side navigation state for brust, driven by the SPA navigator in
// runtime/islands/bootstrap.ts. Fully React-free AND DOM-free: __navInit takes
// the initial path/search as arguments (bootstrap reads location), so this module
// imports nothing web-API and unit-tests without a DOM. The DOM consumer (active
// links + html[data-brust-nav]) lives in ./active-nav.ts.
//
// The `nav` bag of signals is a singleton stashed on globalThis.__BRUST_NAV__:
// signals share their reactive tracker cross-chunk via Symbol.for (see
// store/signal.ts), but the bag OBJECT must also be shared or each Bun.build
// chunk would build its own — the stash gives one object identity for all chunks.
import { signal, type Signal } from '../store/signal.ts'

export type NavPhase = 'idle' | 'loading' | 'success' | 'error'

export interface NavState {
  path: string
  search: string
  phase: NavPhase
  error: Error | null
  from: string | null
  to: string | null
}

export interface NavStore {
  path: Signal<string>
  search: Signal<string>
  phase: Signal<NavPhase>
  error: Signal<Error | null>
  from: Signal<string | null>
  to: Signal<string | null>
}

type BeforeCb = (e: { from: string; to: string }) => void
type NavCb = (e: NavState) => void
type ErrorCb = (e: { to: string; error: Error }) => void

interface NavInternal extends NavStore {
  _subs: Set<NavCb>
  _before: Set<BeforeCb>
  _success: Set<NavCb>
  _error: Set<ErrorCb>
}

function createNav(): NavInternal {
  return {
    path: signal(''),
    search: signal(''),
    phase: signal<NavPhase>('idle'),
    error: signal<Error | null>(null),
    from: signal<string | null>(null),
    to: signal<string | null>(null),
    _subs: new Set(),
    _before: new Set(),
    _success: new Set(),
    _error: new Set(),
  }
}

const G = globalThis as { __BRUST_NAV__?: NavInternal }
function store(): NavInternal {
  if (!G.__BRUST_NAV__) G.__BRUST_NAV__ = createNav()
  return G.__BRUST_NAV__
}

// Public reactive handle. A Proxy resolves the singleton on each property access
// so (a) every chunk's `nav` points at the one globalThis bag, and (b) tests that
// reset the singleton see the fresh signals.
export const nav: NavStore = new Proxy({} as NavStore, {
  get(_t, prop: string) {
    return (store() as unknown as Record<string, unknown>)[prop]
  },
})

export function getNavState(): NavState {
  const s = store()
  return {
    path: s.path(),
    search: s.search(),
    phase: s.phase(),
    error: s.error(),
    from: s.from(),
    to: s.to(),
  }
}

function emit(s: NavInternal): void {
  const snap = getNavState()
  for (const cb of [...s._subs]) cb(snap)
}

export function subscribe(cb: NavCb): () => void {
  const s = store()
  s._subs.add(cb)
  return () => s._subs.delete(cb)
}
export function onBeforeNavigate(cb: BeforeCb): () => void {
  const s = store()
  s._before.add(cb)
  return () => s._before.delete(cb)
}
export function onNavigate(cb: NavCb): () => void {
  const s = store()
  s._success.add(cb)
  return () => s._success.delete(cb)
}
export function onNavigateError(cb: ErrorCb): () => void {
  const s = store()
  s._error.add(cb)
  return () => s._error.delete(cb)
}

export function __navInit(path: string, search: string): void {
  const s = store()
  s.path.set(path)
  s.search.set(search)
  s.phase.set('idle')
  s.from.set(null)
  s.to.set(null)
  s.error.set(null)
  emit(s)
}

export function __navStart(toPath: string, _toSearch: string): void {
  const s = store()
  const from = s.path()
  s.from.set(from)
  s.to.set(toPath)
  s.error.set(null)
  s.phase.set('loading')
  for (const cb of [...s._before]) cb({ from, to: toPath })
  emit(s)
}

export function __navCommit(toPath: string, toSearch: string): void {
  const s = store()
  s.path.set(toPath)
  s.search.set(toSearch)
  s.to.set(null)
  s.error.set(null)
  s.phase.set('success')
  const snap = getNavState()
  for (const cb of [...s._success]) cb(snap)
  emit(s)
}

export function __navError(toPath: string, error: Error): void {
  const s = store()
  s.to.set(null)
  s.error.set(error)
  s.phase.set('error')
  for (const cb of [...s._error]) cb({ to: toPath, error })
  emit(s)
}

// Test-only: drop the singleton so the next access rebuilds fresh signals.
export function __resetNavForTest(): void {
  G.__BRUST_NAV__ = undefined
}
```

**VERIFY:** `bun test runtime/navigation/store.test.ts` green. `cd runtime && bunx biome check navigation/` clean (or root `bun run ci`).

**Commit:** `feat(nav): navigation state store (signals + lifecycle hooks)`

---

## T2 — `runtime/navigation/active-nav.ts` + `active-nav.test.ts`

**RED** — `runtime/navigation/active-nav.test.ts` (needs DOM — mirror bootstrap.test.ts happy-dom `beforeAll`; do NOT import bootstrap.ts):

```ts
// runtime/navigation/active-nav.test.ts
import { test, expect, beforeAll, beforeEach } from 'bun:test'
import { Window } from 'happy-dom'

let installActiveNav: () => void
let __resetActiveNavForTest: () => void
let nav: typeof import('./store.ts').nav
let __navInit: typeof import('./store.ts').__navInit
let __navCommit: typeof import('./store.ts').__navCommit
let __resetNavForTest: typeof import('./store.ts').__resetNavForTest

beforeAll(async () => {
  const win = new Window({ url: 'http://localhost/' })
  ;(win as unknown as Record<string, unknown>).SyntaxError = SyntaxError
  ;(win as unknown as Record<string, unknown>).TypeError = TypeError
  Object.assign(globalThis, {
    document: win.document,
    window: win,
    location: win.location,
    HTMLElement: win.HTMLElement,
    HTMLAnchorElement: (win as unknown as Record<string, unknown>).HTMLAnchorElement,
    URL,
  })
  const store = await import('./store.ts')
  nav = store.nav
  __navInit = store.__navInit
  __navCommit = store.__navCommit
  __resetNavForTest = store.__resetNavForTest
  const an = await import('./active-nav.ts')
  installActiveNav = an.installActiveNav
  __resetActiveNavForTest = an.__resetActiveNavForTest
})

beforeEach(() => {
  __resetNavForTest()
  __resetActiveNavForTest()
  document.documentElement.removeAttribute('data-brust-nav')
  document.body.innerHTML = ''
})

function navMarkup(html: string) {
  document.body.innerHTML = `<nav data-brust-active-nav>${html}</nav>`
}

test('reconciles is-active + aria-current onto the matching link on init', () => {
  navMarkup('<a href="/">Home</a><a href="/type-chart">Chart</a>')
  __navInit('/type-chart', '')
  installActiveNav()
  const links = document.querySelectorAll('a')
  expect(links[0].classList.contains('is-active')).toBe(false)
  expect(links[1].classList.contains('is-active')).toBe(true)
  expect(links[1].getAttribute('aria-current')).toBe('page')
  expect(links[0].getAttribute('aria-current')).toBe(null)
})

test('re-reconciles on committed path change', () => {
  navMarkup('<a href="/">Home</a><a href="/type-chart">Chart</a>')
  __navInit('/', '')
  installActiveNav()
  expect(document.querySelectorAll('a')[0].classList.contains('is-active')).toBe(true)
  __navCommit('/type-chart', '')
  const links = document.querySelectorAll('a')
  expect(links[0].classList.contains('is-active')).toBe(false)
  expect(links[1].classList.contains('is-active')).toBe(true)
})

test('data-brust-active-class overrides the active class', () => {
  document.body.innerHTML =
    '<nav data-brust-active-nav data-brust-active-class="on"><a href="/x">X</a></nav>'
  __navInit('/x', '')
  installActiveNav()
  expect(document.querySelector('a')!.classList.contains('on')).toBe(true)
})

test('prefix match activates a parent link for a nested path', () => {
  document.body.innerHTML =
    '<nav data-brust-active-nav data-brust-active-match="prefix"><a href="/docs">Docs</a></nav>'
  __navInit('/docs/intro', '')
  installActiveNav()
  expect(document.querySelector('a')!.classList.contains('is-active')).toBe(true)
})

test('html[data-brust-nav] mirrors phase, success maps to idle', () => {
  navMarkup('<a href="/">Home</a>')
  __navInit('/', '')
  installActiveNav()
  expect(document.documentElement.getAttribute('data-brust-nav')).toBe('idle')
  __navCommit('/', '') // phase=success
  expect(document.documentElement.getAttribute('data-brust-nav')).toBe('idle')
})

test('<html data-brust-nav> is NOT treated as an active-nav container', () => {
  document.documentElement.setAttribute('data-brust-nav', 'loading')
  document.body.innerHTML = '<a href="/should-not-activate">x</a>' // no container
  __navInit('/should-not-activate', '')
  installActiveNav()
  // link is outside any [data-brust-active-nav] container → untouched
  expect(document.querySelector('a')!.classList.contains('is-active')).toBe(false)
})
```

> Rename the helper `navMarkup` (the `nav`/`navMarkup` split above is illustrative — implementer: name it `navMarkup` consistently; do not shadow the imported `nav`).

**GREEN** — `runtime/navigation/active-nav.ts`:

```ts
// runtime/navigation/active-nav.ts
// The DOM consumer of the navigation store. Installs two effects:
//  - nav.path  → reconcile is-active/aria-current on links in [data-brust-active-nav]
//  - nav.phase → mirror to <html data-brust-nav> for CSS-driven indicators
// Attribute name [data-brust-active-nav] is deliberately distinct from the
// <html data-brust-nav> phase attr so the reconciler never treats <html> as a
// container (which would toggle is-active on every <a> in the document).
import { effect } from '../store/signal.ts'
import { nav, type NavPhase } from './store.ts'

let installed = false

export function installActiveNav(): void {
  if (installed) return
  installed = true
  // effect() runs eagerly once and re-runs whenever a signal it read changes.
  effect(() => {
    const path = nav.path()
    reconcileActiveLinks(path)
  })
  effect(() => {
    const phase = nav.phase()
    setHtmlNav(phase)
  })
}

function setHtmlNav(phase: NavPhase): void {
  if (typeof document === 'undefined' || !document.documentElement) return
  // 'success' is a transient logical phase; the DOM attr returns to idle so
  // loading indicators clear once committed.
  document.documentElement.setAttribute('data-brust-nav', phase === 'success' ? 'idle' : phase)
}

function reconcileActiveLinks(currentPath: string): void {
  if (typeof document === 'undefined') return
  const containers = document.querySelectorAll<HTMLElement>('[data-brust-active-nav]')
  for (const el of Array.from(containers)) {
    const activeClass = el.dataset.brustActiveClass || 'is-active'
    const prefix = el.dataset.brustActiveMatch === 'prefix'
    const links = el.querySelectorAll<HTMLAnchorElement>('a[href]')
    for (const a of Array.from(links)) {
      const linkPath = new URL(a.href, location.href).pathname
      const isActive = prefix
        ? currentPath === linkPath || currentPath.startsWith(`${linkPath.replace(/\/$/, '')}/`)
        : currentPath === linkPath
      a.classList.toggle(activeClass, isActive)
      if (isActive) a.setAttribute('aria-current', 'page')
      else a.removeAttribute('aria-current')
    }
  }
}

// Test-only: allow re-install after __resetNavForTest so the effect rebinds to
// the fresh singleton.
export function __resetActiveNavForTest(): void {
  installed = false
}
```

**VERIFY:** `bun test runtime/navigation/` green (store + active-nav).

> **BLOCKED fallback:** if happy-dom's `classList.toggle(cls, force)` or `dataset` differ from the test's expectation, assert via `a.className`/`getAttribute('class')` instead; do not change the impl's standard DOM calls.

**Commit:** `feat(nav): active-link reconciler + html[data-brust-nav] phase attr`

---

## T3 — public export + package.json + tsc gate

1. `runtime/navigation/index.ts`:

```ts
// runtime/navigation/index.ts — brustjs/navigation. React-free, DOM-free entry.
// (active-nav.ts uses DOM globals but imports no DOM module; it's re-exported for
// authors who add nav containers dynamically. bootstrap wires it automatically.)
export type { NavPhase, NavState, NavStore } from './store.ts'
export {
  nav,
  getNavState,
  subscribe,
  onBeforeNavigate,
  onNavigate,
  onNavigateError,
} from './store.ts'
export { installActiveNav } from './active-nav.ts'
```

2. `package.json` — add to `exports` (after `"./native"`):

```json
    "./native": "./runtime/native/index.ts",
    "./navigation": "./runtime/navigation/index.ts"
```

3. `runtime/tsconfig.typecheck.json` — extend `files`:

```json
  "files": ["treaty.ts", "define-actions.ts", "standard-schema.ts", "treaty.type-test.ts", "navigation/index.ts", "navigation/store.ts", "navigation/active-nav.ts"]
```

**VERIFY:** `bun run typecheck:treaty` exit 0. (Adding the three files pulls `store/signal.ts` into the gate transitively.)

> **BLOCKED fallback:** if `signal.ts` itself trips the gate (it newly enters the type-check graph), do NOT loosen `signal.ts`. First try adding `store/signal.ts` to `files` and fixing any `types:[]`-surfaced issue minimally. If a fix would touch signal.ts semantics, BACK OUT the tsconfig change (keep nav out of the gate), leave a `// TODO(nav): add to typecheck:treaty once signal.ts is gate-clean` note in tsconfig, and record it as a known limitation — do NOT block the feature on it.

**Commit:** `feat(nav): export brustjs/navigation + add to typecheck:treaty gate`

---

## T4 — bootstrap.ts wiring + extend bootstrap.test.ts

**Edits to `runtime/islands/bootstrap.ts`:**

1. After the existing imports (around line 18), add:

```ts
import {
  __navStart,
  __navCommit,
  __navError,
  __navInit,
} from '../navigation/store.ts'
import { installActiveNav } from '../navigation/active-nav.ts'
```

2. Change `async function navigate(` → `export async function navigate(` and add the three hook calls:

```ts
export async function navigate(url: URL, push: boolean): Promise<void> {
  inFlight?.abort()
  const ac = new AbortController()
  inFlight = ac
  try {
    __navStart(url.pathname, url.search)
    const resp = await fetch(`/_brust/page${url.pathname}${url.search}`, {
      signal: ac.signal,
      headers: { Accept: 'application/json' },
    })
    if (!resp.ok) throw new Error(`navigation: status ${resp.status}`)
    const { html, title, store } = (await resp.json()) as {
      html: string
      title: string
      store?: Record<string, Record<string, unknown>>
    }
    const main = document.querySelector('main')
    if (!main) throw new Error('navigation: no <main> element')
    unmountIslandsIn(main as HTMLElement)
    swapMainContent(main as HTMLElement, html)
    if (store) applyStoreSnapshot(store)
    if (title) document.title = title
    if (push) history.pushState({}, '', url.href)
    window.scrollTo(0, 0)
    hydrateMarkersIn(main as HTMLElement)
    __navCommit(url.pathname, url.search)
  } catch (err) {
    if ((err as Error).name === 'AbortError') return
    __navError(url.pathname, err as Error)
    console.warn('[brust] SPA navigation failed, falling back to full reload:', err)
    location.href = url.href
  } finally {
    if (inFlight === ac) inFlight = null
  }
}
```

3. In the bottom load block, call `__navInit` + `installActiveNav` BEFORE `installInterceptor()` in BOTH branches:

```ts
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      __navInit(location.pathname, location.search)
      installActiveNav()
      hydrateMarkersIn(document.body)
      installInterceptor()
    })
  } else {
    __navInit(location.pathname, location.search)
    installActiveNav()
    hydrateMarkersIn(document.body)
    installInterceptor()
  }
}
```

**Extend `runtime/islands/bootstrap.test.ts`** (RED→GREEN; the wiring above makes it green). Add to the `beforeAll` global assign: `scrollTo: () => {}` on window/globalThis, and capture `navigate` + nav store helpers:

```ts
// add to the Object.assign(globalThis, {...}) block:
//   scrollTo: () => {},
//   fetch: undefined as unknown,  // set per-test
// after the dynamic import in beforeAll:
//   navigate = mod.navigate
// import the nav store helpers at top (static import is fine — no DOM needed):
import { getNavState, subscribe, __resetNavForTest } from '../navigation/store.ts'
```

New test (mirror the file's style):

```ts
test('navigate() drives nav store loading → success and commits path', async () => {
  __resetNavForTest()
  document.body.innerHTML = '<main></main>'
  ;(globalThis as Record<string, unknown>).fetch = mock(async () => ({
    ok: true,
    json: async () => ({ html: '<p>swapped</p>', title: 'Chart', store: undefined }),
  }))
  const phases: string[] = []
  const unsub = subscribe((s) => phases.push(s.phase))
  await navigate(new URL('http://localhost/type-chart'), true)
  unsub()
  expect(phases).toContain('loading')
  expect(getNavState().path).toBe('/type-chart')
  expect(getNavState().phase).toBe('success')
  expect(document.querySelector('main')!.textContent).toContain('swapped')
})
```

Declare `let navigate: (url: URL, push: boolean) => Promise<void>` at module scope near the other `let` decls.

**VERIFY:** `bun test runtime/islands/bootstrap.test.ts` green; then `cd runtime && bun run build:debug && cd ..` (rebuild addon is unaffected — no Rust — but run once to be safe) and `bun test runtime/` full green, no regressions.

> **BLOCKED fallback:** if importing `../navigation/active-nav.ts` into bootstrap pulls a happy-dom-incompatible call at module load, move `installActiveNav` import to a lazy `await import` inside the load block. If `window.scrollTo` is missing in happy-dom and throws, the `scrollTo: () => {}` stub in beforeAll fixes it; do not remove the `scrollTo` call from bootstrap.

**Commit:** `feat(nav): wire navigation lifecycle into SPA navigator + tests`

---

## T5 — pokedex AppLayout + app.css loading bar

1. `example/pokedex/components/AppLayout.tsx` — add the static marker to the sidebar `<nav>` (line 52):

```tsx
          <nav className="aa-sidebar__nav" data-brust-active-nav>
```

No other change to AppLayout (keep the SSR conditional `is-active` for first paint).

2. `example/pokedex/app.css` — append a CSS-only nav progress bar (match the file's existing token/color conventions; the values below are a safe default — implementer: prefer an existing brand variable if one exists in app.css):

```css
/* SPA navigation progress bar — driven purely by <html data-brust-nav>. */
html[data-brust-nav='loading'] body::before {
  content: '';
  position: fixed;
  inset: 0 0 auto 0;
  height: 3px;
  z-index: 9999;
  background: linear-gradient(90deg, transparent, var(--accent, #6366f1), transparent);
  background-size: 50% 100%;
  background-repeat: no-repeat;
  animation: brust-nav-progress 0.9s ease-in-out infinite;
}
html[data-brust-nav='error'] body::before {
  content: '';
  position: fixed;
  inset: 0 0 auto 0;
  height: 3px;
  z-index: 9999;
  background: #ef4444;
}
@keyframes brust-nav-progress {
  from { background-position: -50% 0; }
  to { background-position: 150% 0; }
}
```

**VERIFY:** `bun run ci` (biome) clean (CSS isn't linted by biome but the TSX edit is). Build the pokedex: `cd example/pokedex && bun run --cwd ../.. runtime/cli/index.ts build example/pokedex/index.ts` — OR simpler, defer the runtime smoke to T6. Confirm AppLayout still compiles native (no soft-fallback): the marker is a static attr, so it must not break the single-return native constraint.

> **BLOCKED fallback:** if the native compiler rejects `data-brust-active-nav` as a bare boolean attr, write it as `data-brust-active-nav=""` explicitly. If `var(--accent)` is undefined in app.css, the `#6366f1` fallback in `var()` covers it — no failure.

**Commit:** `feat(pokedex): SPA route-active sidebar via data-brust-active-nav + nav progress bar`

---

## T6 — full verification + dev smoke (orchestrator, Phase 6)

Re-run ALL baselines myself (not subagent-reported):

```bash
bun run typecheck:treaty            # exit 0 (3 nav files in gate)
bun test runtime/navigation/        # green
bun test runtime/islands/bootstrap.test.ts
bun test runtime/                    # full, no regressions vs baseline count
bun run ci                           # biome clean
cargo fmt --all --check              # sanity (no Rust change)
```

Dev smoke (pokedex) — kill stale port first (`lsof -ti:1337 | xargs kill -9`), then `BRUST_PORT=1337 bun run runtime/cli/index.ts dev example/pokedex/index.ts`, drive with chrome-devtools MCP:
- Load `/`, confirm sidebar "All Pokémon" has `is-active` + `aria-current="page"`.
- SPA-click "Type chart" → no full reload (no network doc nav), `<main>` swaps, sidebar active moves to "Type chart", `<html>` `data-brust-nav` flips `loading`→`idle`.
- Browser back → active returns to "All Pokémon".

Then Phase 6 scrutinize (diff trace) + open PR.
