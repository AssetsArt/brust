import { effect as coreEffect, signal, type Dispose, type Signal } from './signal'
import type { BehaviorCtx, BehaviorFactory, BehaviorInstance } from './registry'

/** Defined by `brust build --dev` (true) and every other build (false): the dev code below is removed from production bundles. */
declare const __BRUST_DEV__: boolean | undefined
/** Dev only (L14): the live instances, for the devtools (`globalThis.__brustDev.instances`). */
function devTrack(i: Instance, on: boolean): void {
  const g = globalThis as { __brustDev?: { instances: Set<Instance> } }
  const dev = (g.__brustDev ??= { instances: new Set<Instance>() })
  if (on) dev.instances.add(i)
  else dev.instances.delete(i)
}

export class Instance {
  members: BehaviorInstance = {}
  props: Signal<Record<string, unknown>>
  refs = new Map<string, { current: Element | null }>()
  children = new Set<Instance>()
  private disposers: Dispose[] = []
  private cleanups: Array<() => void> = []
  disposed = false
  /** false until the initial bind pass finishes; the first-paint tripwire only applies before then. */
  booted = false
  /** Effects the component declared while its factory ran: they start once the instance is bound (x-ref, x-on), like React's commit (F97). */
  private pending: Array<[() => void | (() => void), Dispose?]> | null = []

  constructor(public host: HTMLElement, public name: string, public parent: Instance | null, initialProps: Record<string, unknown>) {
    this.props = signal(initialProps)
    parent?.children.add(this)
    if (typeof __BRUST_DEV__ !== 'undefined' && __BRUST_DEV__) devTrack(this, true)
  }

  effect(fn: () => void | (() => void)): Dispose {
    const d = coreEffect(fn); this.disposers.push(d); return d
  }
  /** `ctx.effect`: deferred until `start()` while the factory runs, immediate afterwards. */
  private componentEffect(fn: () => void | (() => void)): Dispose {
    if (!this.pending) return this.effect(fn)
    const q: [() => void | (() => void), Dispose?] = [fn]
    this.pending.push(q)
    return () => { q[0] = () => {}; q[1]?.() }
  }
  /**
   * Runs the queued component effects, in declaration order. Call after the initial bind pass.
   * Order across hosts: a static nested host mounts after its parent (document order), so a
   * parent's effects start before the child is bound; hosts created by x-if / x-for during the
   * parent's bind pass start their own effects first. A throwing effect is handled like a
   * throwing factory: logged, the instance disposed; returns false then.
   */
  start(): boolean {
    const queue = this.pending
    this.pending = null
    for (const q of queue ?? []) {
      if (this.disposed) break
      try { q[1] = this.effect(q[0]) }
      catch (e) { console.error(`[brust] effect threw: ${this.name}`, e); this.dispose(); instances.delete(this.host); return false }
    }
    return true
  }
  onCleanup(fn: () => void): void { this.cleanups.push(fn) }
  ref<E extends Element = HTMLElement>(name: string): { current: E | null } {
    let r = this.refs.get(name)
    if (!r) { r = { current: null }; this.refs.set(name, r) }
    return r as { current: E | null }
  }
  ctx(): BehaviorCtx {
    return { el: this.host, props: this.props, effect: (fn) => this.componentEffect(fn), onCleanup: (fn) => this.onCleanup(fn), ref: (n) => this.ref(n) }
  }
  init(factory: BehaviorFactory): void {
    const m = factory(this.ctx())
    if (m && typeof m === 'object') this.members = m
    if (typeof this.members.init === 'function') (this.members.init as () => void)()
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (typeof __BRUST_DEV__ !== 'undefined' && __BRUST_DEV__) devTrack(this, false)
    this.pending = null   // effects not yet started never run
    for (const c of Array.from(this.children)) c.dispose()
    this.parent?.children.delete(this)
    for (const d of this.disposers.splice(0)) d()
    for (const c of this.cleanups.splice(0)) { try { c() } catch (e) { console.error('[brust] cleanup threw', e) } }
  }
}

export const instances = new WeakMap<Element, Instance>()
export function instanceOf(el: Element): Instance | undefined { return instances.get(el) }
/** Instance of the nearest ancestor HOST. A host that has not mounted yet (chunk loading) yields null: wait, never skip to a farther ancestor. */
export function nearestInstance(el: Element): Instance | null {
  const h = el.parentElement?.closest('[x-data]')
  return (h && instances.get(h)) || null
}

/** Late-bound by mount.ts so binders (x-if, x-for) can mount nested hosts synchronously without an import cycle. */
export const hooks: { mountTree: (root: ParentNode) => void } = { mountTree: () => {} }

/** Late-bound by the `island` feature (features/island.ts) so a page without React islands never loads the hydration glue. */
export const islandHooks: { schedule: (root: ParentNode) => void; cancel: (root: Node) => void } = { schedule: () => {}, cancel: () => {} }
