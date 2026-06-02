// runtime/store/index.ts — brustjs/store. Isomorphic, framework-free, dom-free.
// No UI-framework adapter is re-exported here (the view-layer binding lives
// separately and is reachable only from the brustjs main entry).
export { signal, computed, effect, batch, isSignal, isComputed } from './signal.ts'
export type { Signal, Computed } from './signal.ts'
export { defineStore } from './define-store.ts'
export type { StoreHandle, Snapshot } from './define-store.ts'
export { toScriptJson, parseStoreScript, storeScriptTag } from './serialize.ts'
