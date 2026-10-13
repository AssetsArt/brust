// The full runtime: the core plus every feature. Tests and non-split consumers import this; the browser build
// loads `./core` and only the `./features/*` a route needs.
export * from './core'
export { defineStore } from './store/define-store'
export type { StoreHandle, Snapshot } from './store/define-store'
export { defineIsland } from './island'
export type { IslandHydrate } from './island'
import './features/index'
