// runtime/navigation/server-context.ts
// Server-only: imports a Node builtin (node:async_hooks), so it must NOT be
// reachable from browser/island bundles (brustjs/client) or the React-free,
// DOM-free navigation entry (brustjs/navigation = ./index.ts). It mirrors
// store/server-context.ts: the server pulls this module in via routes.ts, where
// each render is wrapped in a per-request nav scope; navigation/store.ts reaches
// the active scope through the resolver registered below (__setServerNavResolver),
// which stays out of the client bundle (store.ts never imports this file).
import { AsyncLocalStorage } from 'node:async_hooks'
import { __setServerNavResolver, type ServerNavScope } from './store.ts'

const navContext = new AsyncLocalStorage<ServerNavScope>()

/** Open a per-request nav scope so SSR — React islands AND native island SSR —
 * sees the current request path via useNav()/getNavState() instead of the idle
 * singleton default. `search` is the raw query string INCLUDING the leading '?'
 * (so it matches the client's `location.search`), or '' when there is none. */
export function runInNavContext<T>(path: string, search: string, fn: () => T): T {
  return navContext.run({ path, search }, fn)
}

__setServerNavResolver(() => navContext.getStore())
