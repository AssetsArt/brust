// Minimal pull-based reactive core: push-on-write, pull-on-read, synchronous notify.
// Framework-agnostic — no react, no dom. Foundation for defineStore (Spec A) and
// the Alpine-style client runtime (Spec B).

// Symbol.for (GLOBAL registry), NOT Symbol(): every island is a SEPARATE Bun.build
// chunk that inlines its own copy of this module, so a plain `Symbol()` brand would
// be a DIFFERENT value per chunk — `isSignal` from chunk B then fails to recognize a
// signal created in chunk A. That poisons the shared store snapshot (a cross-chunk
// reader computes `{}` and caches it), so e.g. the team dock reads empty after a SPA
// nav loads a new island chunk. A global registry symbol is identical across chunks.
const SIGNAL = Symbol.for('brust.signal')
const COMPUTED = Symbol.for('brust.computed')

export interface Signal<T> {
  (): T
  set(next: T | ((prev: T) => T)): void
  readonly [SIGNAL]: true
}
export interface Computed<T> {
  (): T
  readonly [COMPUTED]: true
}

export function isSignal(v: unknown): v is Signal<unknown> {
  return typeof v === 'function' && (v as { [SIGNAL]?: true })[SIGNAL] === true
}
export function isComputed(v: unknown): v is Computed<unknown> {
  return typeof v === 'function' && (v as { [COMPUTED]?: true })[COMPUTED] === true
}

// A reactive consumer (effect or computed) tracking its dependencies.
interface Consumer {
  run(): void
  deps: Set<Set<Consumer>>
  running: boolean
}

// The dependency-tracking state (the "currently running consumer", the batch
// depth, the pending-notify queue) MUST be shared across chunks, for the SAME
// reason the brands use Symbol.for: every island / the directive runtime is a
// SEPARATE Bun.build that inlines its own copy of THIS module. If `activeConsumer`
// were a module-local `let`, each chunk would have its own — so an `effect` in
// chunk B reading a `signal` created in chunk A would register against chunk A's
// (always-null) activeConsumer and never subscribe. Concretely: a native directive
// button's effect (its own chunk) would never re-run when a React island (another
// chunk) mutated the shared store, even though the store value changed. Holding the
// context on `globalThis` under a Symbol.for key makes all chunks share ONE tracker.
interface ReactiveCtx {
  activeConsumer: Consumer | null
  batchDepth: number
  pendingNotify: Set<Consumer>
}
const CTX_KEY = Symbol.for('brust.reactive.ctx')
const ctxHolder = globalThis as { [CTX_KEY]?: ReactiveCtx }
if (!ctxHolder[CTX_KEY]) {
  ctxHolder[CTX_KEY] = { activeConsumer: null, batchDepth: 0, pendingNotify: new Set<Consumer>() }
}
const ctx: ReactiveCtx = ctxHolder[CTX_KEY]

function track(subscribers: Set<Consumer>): void {
  if (ctx.activeConsumer) {
    subscribers.add(ctx.activeConsumer)
    ctx.activeConsumer.deps.add(subscribers)
  }
}

function notify(subscribers: Set<Consumer>): void {
  // Snapshot — a consumer re-running mutates the set.
  for (const c of [...subscribers]) {
    if (ctx.batchDepth > 0) ctx.pendingNotify.add(c)
    else c.run()
  }
}

function flush(): void {
  const queued = [...ctx.pendingNotify]
  ctx.pendingNotify.clear()
  for (const c of queued) c.run()
}

export function batch(fn: () => void): void {
  ctx.batchDepth++
  try {
    fn()
  } finally {
    ctx.batchDepth--
    if (ctx.batchDepth === 0) flush()
  }
}

export function signal<T>(initial: T): Signal<T> {
  let value = initial
  const subscribers = new Set<Consumer>()
  const read = (() => {
    track(subscribers)
    return value
  }) as Signal<T>
  read.set = (next: T | ((prev: T) => T)) => {
    const v = typeof next === 'function' ? (next as (p: T) => T)(value) : next
    if (Object.is(v, value)) return
    value = v
    notify(subscribers)
  }
  Object.defineProperty(read, SIGNAL, { value: true })
  return read
}

function clearDeps(c: Consumer): void {
  for (const dep of c.deps) dep.delete(c)
  c.deps.clear()
}

export function computed<T>(fn: () => T): Computed<T> {
  let cached: T
  let dirty = true
  const subscribers = new Set<Consumer>()
  const self: Consumer = {
    deps: new Set(),
    running: false,
    run() {
      if (self.running) return
      self.running = true
      try {
        dirty = true
        notify(subscribers) // downstream recomputes lazily on next read
      } finally {
        self.running = false
      }
    },
  }
  const read = (() => {
    track(subscribers)
    if (dirty) {
      clearDeps(self)
      const prev = ctx.activeConsumer
      ctx.activeConsumer = self
      try {
        cached = fn()
        dirty = false
      } finally {
        ctx.activeConsumer = prev
      }
    }
    return cached
  }) as Computed<T>
  Object.defineProperty(read, COMPUTED, { value: true })
  return read
}

export function effect(fn: () => void): () => void {
  const self: Consumer = {
    deps: new Set(),
    running: false,
    run() {
      if (self.running) return
      self.running = true
      clearDeps(self)
      const prev = ctx.activeConsumer
      ctx.activeConsumer = self
      try {
        fn()
      } finally {
        ctx.activeConsumer = prev
        self.running = false
      }
    },
  }
  self.run()
  return () => clearDeps(self)
}
