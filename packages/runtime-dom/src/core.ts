// The always-loaded core: signals, the behavior registry, mount/unmount and the binder registry. Features
// (./features/*) register their binders on import; nothing here knows a directive by name.
export { signal, computed, effect, batch, untracked, isSignal, isComputed } from './signal'
export type { Signal, Computed, Dispose } from './signal'
export { defineBehavior, setChunkLoader } from './registry'
export type { BehaviorCtx, BehaviorFactory, BehaviorInstance } from './registry'
export { mount, unmount } from './mount'
export * from './core-api'
