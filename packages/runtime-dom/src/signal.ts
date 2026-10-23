// A small push-pull reactive core. Signals push "dirty" to subscribers; computeds pull lazily.
type Subscriber = { mark(): void; deps: Set<Node> }
type Node = { subs: Set<Subscriber> }
type Runnable = { disposed: boolean; run(): void; post?: boolean }
interface ReactiveCtx { currentSub: Subscriber | null; batchDepth: number; pending: Set<Runnable> }

const CTX = Symbol.for('brust.reactive.ctx')          // M3-F C7
const SIGNAL = Symbol.for('brust.signal')             // M3-F C7
const COMPUTED = Symbol.for('brust.computed')         // M3-F C7
// ONE object per realm. Every copy of this module binds `ctx` once at load; hot paths do one
// property load on a module-constant object. The shape is fixed: a copy never adds fields, so
// copies of any version agree.
const ctx: ReactiveCtx = ((globalThis as { [CTX]?: ReactiveCtx })[CTX] ??= { currentSub: null, batchDepth: 0, pending: new Set() })

function track(node: Node) {
  const s = ctx.currentSub
  if (s) { node.subs.add(s); s.deps.add(node) }
}
function notify(node: Node) {
  for (const s of Array.from(node.subs)) s.mark()
}
function flush() {
  if (ctx.batchDepth > 0) return
  const pending = ctx.pending
  while (pending.size) {
    const batch = Array.from(pending)
    // F288: a `post` effect (`useLayoutEffect`) re-runs only once every other effect of the change has run, so it reads
    // the DOM after every binding updated it: React's commit, then layout effects.
    const now = batch.filter((e) => !e.post)
    const run = now.length ? now : batch
    for (const e of run) pending.delete(e)
    for (const e of run) if (!e.disposed) e.run()
  }
}

export interface Signal<T> { (): T; set(next: T | ((prev: T) => T)): void; readonly peek: () => T; readonly [SIGNAL]: true }
export interface Computed<T> { (): T; readonly peek: () => T; readonly [COMPUTED]: true }
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
  ;(read as { [SIGNAL]: true })[SIGNAL] = true
  return read
}

export function computed<T>(fn: () => T): Computed<T> {
  let value: T; let dirty = true
  const node: Node = { subs: new Set() }
  const sub: Subscriber = { deps: new Set(), mark() { if (!dirty) { dirty = true; notify(node) } } }
  const recompute = () => {
    for (const d of sub.deps) d.subs.delete(sub); sub.deps.clear()
    const prev = ctx.currentSub; ctx.currentSub = sub
    try { value = fn() } finally { ctx.currentSub = prev }
    dirty = false
  }
  const read = (() => { track(node); if (dirty) recompute(); return value }) as Computed<T>
  ;(read as { peek: () => T }).peek = () => { if (dirty) recompute(); return value }
  ;(read as { [COMPUTED]: true })[COMPUTED] = true
  return read
}

// Cleanups run untracked: a read inside one must not subscribe whichever effect is running around it.
function runCleanup(c: () => void) { const prev = ctx.currentSub; ctx.currentSub = null; try { c() } finally { ctx.currentSub = prev } }

class EffectImpl implements Subscriber {
  deps = new Set<Node>(); disposed = false; cleanup: void | (() => void) = undefined
  constructor(private fn: () => void | (() => void), readonly post = false) {}
  mark() { ctx.pending.add(this) }
  run() {
    if (this.disposed) return
    if (this.cleanup) { const c = this.cleanup; this.cleanup = undefined; runCleanup(c) }
    for (const d of this.deps) d.subs.delete(this); this.deps.clear()
    const prev = ctx.currentSub; ctx.currentSub = this
    try { this.cleanup = this.fn() } finally { ctx.currentSub = prev }
  }
  dispose() {
    if (this.disposed) return
    this.disposed = true; ctx.pending.delete(this)
    for (const d of this.deps) d.subs.delete(this); this.deps.clear()
    if (this.cleanup) { const c = this.cleanup; this.cleanup = undefined; runCleanup(c) }
  }
}

export function effect(fn: () => void | (() => void), post = false): Dispose {
  const e = new EffectImpl(fn, post)
  try { e.run() } catch (x) { e.dispose(); throw x }   // F98: a first run that throws must not stay subscribed
  return () => e.dispose()
}

export function batch(fn: () => void): void {
  ctx.batchDepth++
  try { fn() } finally { ctx.batchDepth--; flush() }
}

export function untracked<T>(fn: () => T): T {
  const prev = ctx.currentSub; ctx.currentSub = null
  try { return fn() } finally { ctx.currentSub = prev }
}

export function isSignal(x: unknown): x is Signal<unknown> { return typeof x === 'function' && (x as { [SIGNAL]?: true })[SIGNAL] === true }
export function isComputed(x: unknown): x is Computed<unknown> { return typeof x === 'function' && (x as { [COMPUTED]?: true })[COMPUTED] === true }
/** Signal or computed: what directive paths unwrap. Internal (not in D1). */
export function isReactive(x: unknown): x is Signal<unknown> | Computed<unknown> {
  return typeof x === 'function' && ((x as { [SIGNAL]?: true })[SIGNAL] === true || (x as { [COMPUTED]?: true })[COMPUTED] === true)
}
