// A small push-pull reactive core. Signals push "dirty" to subscribers; computeds pull lazily.
type Subscriber = { mark(): void; deps: Set<Node> }
type Node = { subs: Set<Subscriber> }

let currentSub: Subscriber | null = null
let batchDepth = 0
const pending = new Set<EffectImpl>()

function track(node: Node) {
  if (currentSub) { node.subs.add(currentSub); currentSub.deps.add(node) }
}
function notify(node: Node) {
  for (const s of Array.from(node.subs)) s.mark()
}
function flush() {
  if (batchDepth > 0) return
  while (pending.size) {
    const batch = Array.from(pending); pending.clear()
    for (const e of batch) if (!e.disposed) e.run()
  }
}

export interface Signal<T> { (): T; set(next: T | ((prev: T) => T)): void; readonly peek: () => T }
export interface Computed<T> { (): T; readonly peek: () => T }
export type Dispose = () => void

export function signal<T>(initial: T): Signal<T> {
  let value = initial
  const node: Node = { subs: new Set() }
  const read = (() => { track(node); return value }) as Signal<T>
  read.set = (next) => {
    const v = typeof next === 'function' ? (next as (p: T) => T)(value) : next
    if (Object.is(v, value)) return
    value = v
    notify(node)
    flush()
  }
  ;(read as { peek: () => T }).peek = () => value
  return read
}

export function computed<T>(fn: () => T): Computed<T> {
  let value: T; let dirty = true
  const node: Node = { subs: new Set() }
  const sub: Subscriber = { deps: new Set(), mark() { if (!dirty) { dirty = true; notify(node) } } }
  const recompute = () => {
    for (const d of sub.deps) d.subs.delete(sub); sub.deps.clear()
    const prev = currentSub; currentSub = sub
    try { value = fn() } finally { currentSub = prev }
    dirty = false
  }
  const read = (() => { track(node); if (dirty) recompute(); return value }) as Computed<T>
  ;(read as { peek: () => T }).peek = () => { if (dirty) recompute(); return value }
  return read
}

class EffectImpl implements Subscriber {
  deps = new Set<Node>(); disposed = false; cleanup: void | (() => void) = undefined
  constructor(private fn: () => void | (() => void)) {}
  mark() { pending.add(this) }
  run() {
    if (this.disposed) return
    if (this.cleanup) { const c = this.cleanup; this.cleanup = undefined; c() }
    for (const d of this.deps) d.subs.delete(this); this.deps.clear()
    const prev = currentSub; currentSub = this
    try { this.cleanup = this.fn() } finally { currentSub = prev }
  }
  dispose() {
    if (this.disposed) return
    this.disposed = true; pending.delete(this)
    for (const d of this.deps) d.subs.delete(this); this.deps.clear()
    if (this.cleanup) { const c = this.cleanup; this.cleanup = undefined; c() }
  }
}

export function effect(fn: () => void | (() => void)): Dispose {
  const e = new EffectImpl(fn)
  e.run()
  return () => e.dispose()
}

export function batch(fn: () => void): void {
  batchDepth++
  try { fn() } finally { batchDepth--; flush() }
}

export function untracked<T>(fn: () => T): T {
  const prev = currentSub; currentSub = null
  try { return fn() } finally { currentSub = prev }
}

export function isSignal(x: unknown): x is Signal<unknown> | Computed<unknown> {
  return typeof x === 'function' && 'peek' in (x as object)
}
