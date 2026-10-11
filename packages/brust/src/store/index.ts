// The documented import (M3-F D1). Server-side plumbing lives in ./server-context.ts (SERVER lane),
// never re-exported here.
export { signal, computed, effect, batch, untracked, isSignal, isComputed, defineStore } from '@brust/runtime-dom/store'
export type { Signal, Computed, Dispose, StoreHandle, Snapshot } from '@brust/runtime-dom/store'
