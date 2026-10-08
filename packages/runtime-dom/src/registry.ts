import type { Dispose, Signal } from './signal'

export interface BehaviorCtx {
  el: HTMLElement
  props: Signal<Record<string, unknown>>
  effect: (fn: () => void | (() => void)) => Dispose
  onCleanup: (fn: () => void) => void
  ref: <E extends Element = HTMLElement>(name: string) => { current: E | null }
}
export type BehaviorInstance = Record<string, unknown>
export type BehaviorFactory = (ctx: BehaviorCtx) => BehaviorInstance | void

const registry = new Map<string, BehaviorFactory>()
const waiters = new Map<string, Array<(f: BehaviorFactory) => void>>()
let loader: ((name: string) => Promise<unknown>) | null = null
const requested = new Set<string>()

export function defineBehavior(name: string, factory: BehaviorFactory): BehaviorFactory {
  registry.set(name, factory)
  const w = waiters.get(name); waiters.delete(name)
  w?.forEach((cb) => cb(factory))
  return factory
}
export function setChunkLoader(load: (name: string) => Promise<unknown>): void { loader = load; requested.clear() }
export function getBehavior(name: string): BehaviorFactory | undefined { return registry.get(name) }

/** Resolve a factory now or when its chunk arrives. Requests the chunk at most once per name. */
export function whenBehavior(name: string, cb: (f: BehaviorFactory) => void): void {
  const f = registry.get(name)
  if (f) { cb(f); return }
  const list = waiters.get(name) ?? []; list.push(cb); waiters.set(name, list)
  if (loader && !requested.has(name)) {
    requested.add(name)
    loader(name).catch((e) => console.error(`[brust] chunk load failed: ${name}`, e))
  }
}
/** Test helper: forget everything. */
export function _resetRegistry(): void { registry.clear(); waiters.clear(); loader = null; requested.clear() }
