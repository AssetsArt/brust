import { effect as coreEffect, signal, type Dispose, type Signal } from './signal'
import type { BehaviorCtx, BehaviorFactory, BehaviorInstance } from './registry'

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

  constructor(public host: HTMLElement, public name: string, public parent: Instance | null, initialProps: Record<string, unknown>) {
    this.props = signal(initialProps)
    parent?.children.add(this)
  }

  effect(fn: () => void | (() => void)): Dispose {
    const d = coreEffect(fn); this.disposers.push(d); return d
  }
  onCleanup(fn: () => void): void { this.cleanups.push(fn) }
  ref<E extends Element = HTMLElement>(name: string): { current: E | null } {
    let r = this.refs.get(name)
    if (!r) { r = { current: null }; this.refs.set(name, r) }
    return r as { current: E | null }
  }
  ctx(): BehaviorCtx {
    return { el: this.host, props: this.props, effect: (fn) => this.effect(fn), onCleanup: (fn) => this.onCleanup(fn), ref: (n) => this.ref(n) }
  }
  init(factory: BehaviorFactory): void {
    const m = factory(this.ctx())
    if (m && typeof m === 'object') this.members = m
    if (typeof this.members.init === 'function') (this.members.init as () => void)()
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
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
