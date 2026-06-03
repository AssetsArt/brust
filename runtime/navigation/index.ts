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
export { navigate, buildSearch } from './navigate.ts'
export type { NavigateOptions, QueryInit, QueryValue } from './navigate.ts'
