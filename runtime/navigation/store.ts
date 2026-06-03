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
