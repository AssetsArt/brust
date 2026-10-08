# M1d — `runtime-dom` (directive runtime + reactive core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `packages/runtime-dom`: the react-free browser runtime that binds a compiled client chunk (`defineBehavior`) to server-rendered HTML through `x-*` attributes, including reactive parent→child props (`x-props-bind`), keyed lists with item-scoped members, refs, and two-way inputs — with unit tests for every directive.

**Architecture:** One TypeScript package, no dependencies. A tiny signal core (`signal`/`computed`/`effect`/`batch`) with React-`useEffect` cleanup semantics; a behavior registry (`defineBehavior(name, factory)`) that mounts one instance per `x-data` host; a `MutationObserver` that mounts added hosts and disposes removed ones; one binder per directive, each an `effect` that reads instance members. Directive values are **member paths with optional scope bindings** (`member[:binding[,binding]]`) — never expressions (spec D7). This package is the contract the M1c client backend prints against; its public surface is frozen at the end of this plan.

**Tech Stack:** TypeScript (strict), Bun 1.4.x (`bun test` with `happy-dom`, `bun build` for the ESM bundle), no runtime dependencies.

**Spec:** `docs/design/2026-10-08-react-compiler-design.md` §7 (client lowering), §7.2 (directive contract), §7.4 (reactive props), D7, D8, §11 (runtime-dom tests).

## Global Constraints

- **Eval-free** (D7): no `new Function`, no `eval`, no attribute-string expression evaluation. A directive value is parsed only as `name(.name)*` plus optional `:binding(,binding)*`.
- **React-free**: the package must not import `react`, `react-dom` or `react/jsx-runtime`; the build step greps the bundle for `from "react` and fails if found (spec §11 "React-freedom").
- **Zero runtime dependencies** in `packages/runtime-dom/package.json` (`dependencies: {}`); `happy-dom` and `typescript` are devDependencies.
- Signal semantics (spec §4.3, §7.1): writes are `Object.is`-deduped; `computed` is lazy and cached; `effect(fn)` runs now and on change, a returned function is a cleanup that runs before each re-run and on dispose; `batch(fn)` defers effect runs to the end of the batch.
- Directive attribute names (spec §7.2), exact spelling: `x-data`, `x-props`, `x-props-bind`, `x-text`, `x-show`, `x-if`, `x-bind-<attr>`, `x-on-<event>`, `x-model`, `x-for`, `x-ref`. No colon forms.
- Nothing re-renders on mount: the server HTML is the initial state; a binder writes the DOM only when its effect re-runs after a change **or** when the initial value differs from what is in the DOM (defensive, logged once in dev — spec §6.3 says they must be equal; a mismatch is a compiler bug the runtime must not hide).
- `bun check` is unavailable on Bun 1.4.2 (M1a F8): the type gate is `bunx tsc --noEmit -p packages/runtime-dom` until Bun ≥ 1.4.3 is pinned.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` (or the implementer's harness trailer).

## Review Focus

1. **A host removed and re-inserted** (SPA swap, `x-if` toggling a subtree that contains hosts) must dispose every effect of the old instance and mount a fresh one — leaking effects double-write the DOM. Task 2 pins it (`disposes on removal, remounts on reinsertion`).
2. **`x-for` with duplicate keys** must not loop forever or drop items silently: warn once and fall back to index identity for the duplicates — Task 5 pins it.
3. **`x-props-bind` on a host whose parent instance is not mounted yet** (chunk still loading): the child must wait for the parent, not bind to `undefined` — Task 6 pins it with a deferred parent registration.
4. **`x-model` on a `<select>` whose option list changes later** (`x-for` inside the select) must re-apply the signal value after the options render — Task 4 pins it.
5. **A directive value with a typo** (`x-text="labl"`) must warn with host + member name and leave the DOM as rendered, never throw and never clear the text — Task 3 pins it.

---

## File structure

```
packages/runtime-dom/
├─ package.json                 name "@brust/runtime-dom", type module, exports ./src/index.ts (dev) and ./dist/index.js (build)
├─ tsconfig.json                strict, lib dom+es2022, noEmit
├─ README.md                    the directive contract (output format) — M1c prints against this
├─ src/
│  ├─ index.ts                  public re-exports (frozen surface, see below)
│  ├─ signal.ts                 signal / computed / effect / batch / untracked
│  ├─ registry.ts               defineBehavior, registry, lazy loader hook
│  ├─ value.ts                  parse "member:bind,bind", resolve member on an instance with scope
│  ├─ instance.ts               Instance: host, props signal, effects, cleanups, refs, children, dispose
│  ├─ mount.ts                  mount(root)/unmount(root), MutationObserver, host discovery, x-props/x-props-bind
│  ├─ directives/
│  │  ├─ text.ts  show.ts  bind.ts  on.ts  if.ts  model.ts  for.ts  ref.ts
│  │  └─ index.ts               bindHost(instance, el, scope): walks the host subtree (stopping at nested hosts) and installs binders
│  └─ warn.ts                   dev warnings (once per key)
├─ test/
│  ├─ setup.ts                  happy-dom GlobalRegistrator
│  ├─ signal.test.ts registry.test.ts mount.test.ts text-show-bind-on.test.ts if-model.test.ts for.test.ts ref-props-bind.test.ts build.test.ts
└─ scripts/build.ts             bun build → dist/index.js, react-freedom + size check
```

Frozen public surface (`src/index.ts`) — M1c and the server spec depend on these names:

```ts
export { signal, computed, effect, batch, untracked } from './signal'
export type { Signal, Computed, Dispose } from './signal'
export { defineBehavior, setChunkLoader } from './registry'
export type { BehaviorCtx, BehaviorFactory, BehaviorInstance } from './registry'
export { mount, unmount } from './mount'
```

```ts
// signal.ts
export interface Signal<T> { (): T; set(next: T | ((prev: T) => T)): void; readonly peek: () => T }
export interface Computed<T> { (): T; readonly peek: () => T }
export type Dispose = () => void
export function signal<T>(initial: T): Signal<T>
export function computed<T>(fn: () => T): Computed<T>
export function effect(fn: () => void | (() => void)): Dispose
export function batch(fn: () => void): void
export function untracked<T>(fn: () => T): T

// registry.ts
export interface BehaviorCtx {
  el: HTMLElement
  props: Signal<Record<string, unknown>>          // a SIGNAL (spec §7.4) — seeded from x-props JSON, rebound by x-props-bind
  effect: (fn: () => void | (() => void)) => Dispose
  onCleanup: (fn: () => void) => void
  ref: <E extends Element = HTMLElement>(name: string) => { current: E | null }
}
export type BehaviorInstance = Record<string, unknown>   // members: signals, computeds, functions, values
export type BehaviorFactory = (ctx: BehaviorCtx) => BehaviorInstance | void
export function defineBehavior(name: string, factory: BehaviorFactory): BehaviorFactory
export function setChunkLoader(load: (name: string) => Promise<unknown>): void

// mount.ts
export function mount(root?: ParentNode): void     // default document.body; idempotent
export function unmount(root?: ParentNode): void
```

Directive value grammar (`value.ts`), the only parsing the runtime does:

```
value    := path (":" bindings)?
path     := ident ("." ident)*
bindings := ident ("," ident)*
```

Resolution: `path` is looked up on the instance members (dotted paths descend plain objects; a signal/computed hop is unwrapped by calling it). If bindings are present the resolved member must be a function and is called with the scope's values for those binding names (loop `item`/`index`), then the result is used. Reads happen inside the binder's effect so dependencies are tracked.

---

### Task 1: Package scaffold + signal core

**Files:**
- Create: `packages/runtime-dom/package.json`, `tsconfig.json`, `src/index.ts`, `src/signal.ts`, `test/setup.ts`, `test/signal.test.ts`
- Modify: root `package.json` (workspaces already lists `packages/*`)

**Interfaces:**
- Produces: `signal`, `computed`, `effect`, `batch`, `untracked` exactly as in the frozen surface.

- [ ] **Step 1: Scaffold**

`packages/runtime-dom/package.json`:

```json
{
  "name": "@brust/runtime-dom",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": { "types": "./src/index.ts", "default": "./src/index.ts" } },
  "scripts": {
    "test": "bun test",
    "typecheck": "bunx tsc --noEmit -p .",
    "build": "bun scripts/build.ts"
  },
  "dependencies": {},
  "devDependencies": { "happy-dom": "^20.0.0", "typescript": "^5.9.0", "@types/bun": "^1.4.0" }
}
```

`packages/runtime-dom/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"], "strict": true, "noUncheckedIndexedAccess": true,
    "noEmit": true, "types": ["bun-types"], "skipLibCheck": true
  },
  "include": ["src", "test", "scripts"]
}
```

`packages/runtime-dom/test/setup.ts`:

```ts
import { GlobalRegistrator } from '@happy-dom/global-registrator'
GlobalRegistrator.register()
```

Add to `packages/runtime-dom/package.json` devDependencies `"@happy-dom/global-registrator": "^20.0.0"` and create `packages/runtime-dom/bunfig.toml`:

```toml
[test]
preload = ["./test/setup.ts"]
```

Install: `cd packages/runtime-dom && bun install` (commit the root `bun.lock`).

- [ ] **Step 2: Failing tests for the signal core**

`packages/runtime-dom/test/signal.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { batch, computed, effect, signal, untracked } from '../src/signal'

describe('signal', () => {
  test('read/write and functional update', () => {
    const n = signal(1)
    expect(n()).toBe(1)
    n.set(2); expect(n()).toBe(2)
    n.set((p) => p + 1); expect(n()).toBe(3)
  })
  test('Object.is dedupe: same value does not notify', () => {
    const n = signal(1); let runs = 0
    effect(() => { n(); runs++ })
    n.set(1); expect(runs).toBe(1)
    n.set(2); expect(runs).toBe(2)
  })
  test('computed is lazy and cached', () => {
    const a = signal(2); let evals = 0
    const d = computed(() => { evals++; return a() * 2 })
    expect(evals).toBe(0)
    expect(d()).toBe(4); expect(d()).toBe(4); expect(evals).toBe(1)
    a.set(3); expect(evals).toBe(1); expect(d()).toBe(6); expect(evals).toBe(2)
  })
  test('effect runs now, re-runs on change, cleanup before re-run and on dispose', () => {
    const a = signal(0); const log: string[] = []
    const dispose = effect(() => { log.push(`run ${a()}`); return () => log.push(`clean ${a.peek()}`) })
    a.set(1)
    dispose()
    expect(log).toEqual(['run 0', 'clean 1', 'run 1', 'clean 1'])
    a.set(2); expect(log.length).toBe(4)
  })
  test('batch defers effects to the end', () => {
    const a = signal(0), b = signal(0); let runs = 0
    effect(() => { a(); b(); runs++ })
    batch(() => { a.set(1); b.set(1) })
    expect(runs).toBe(2)
  })
  test('untracked read does not subscribe', () => {
    const a = signal(0), b = signal(0); let runs = 0
    effect(() => { a(); untracked(() => b()); runs++ })
    b.set(1); expect(runs).toBe(1)
    a.set(1); expect(runs).toBe(2)
  })
  test('computed chain only recomputes once per batch', () => {
    const a = signal(1); let evals = 0
    const b = computed(() => a() + 1); const c = computed(() => { evals++; return b() + 1 })
    effect(() => { c() })
    batch(() => { a.set(2); a.set(3) })
    expect(c()).toBe(5); expect(evals).toBe(2)
  })
})
```

- [ ] **Step 3: Run to verify failure**

Run: `cd packages/runtime-dom && bun test test/signal.test.ts`
Expected: fails to resolve `../src/signal`.

- [ ] **Step 4: Implement `src/signal.ts`**

```ts
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
```

`src/index.ts` for now:

```ts
export { signal, computed, effect, batch, untracked } from './signal'
export type { Signal, Computed, Dispose } from './signal'
```

- [ ] **Step 5: Run to verify pass**

Run: `cd packages/runtime-dom && bun test test/signal.test.ts && bunx tsc --noEmit -p .`
Expected: 7 pass; tsc clean.

- [ ] **Step 6: Commit**

```bash
git add packages/runtime-dom bun.lock package.json
git commit -m "feat(runtime-dom): package scaffold and signal core

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Behavior registry, instances, and mounting

**Files:**
- Create: `src/registry.ts`, `src/instance.ts`, `src/mount.ts`, `src/warn.ts`, `src/value.ts`, `src/directives/index.ts` (walker only; binders arrive in Tasks 3–6), `test/registry.test.ts`, `test/mount.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Produces: `defineBehavior`, `setChunkLoader`, `mount`, `unmount`, `BehaviorCtx`; internal `Instance` class with `members`, `props`, `effect`, `onCleanup`, `refs`, `dispose()`, `parent`; `parseValue(v)` and `resolve(instance, parsed, scope)` in `value.ts`; `bindHost(instance, el, scope)` in `directives/index.ts` walking the subtree and calling a binder table `BINDERS[attrPrefix]`.

- [ ] **Step 1: Failing tests**

`test/registry.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { defineBehavior, setChunkLoader, mount, unmount } from '../src'
import { signal } from '../src/signal'

function html(s: string) { document.body.innerHTML = s; return document.body }

test('mounts one instance per x-data host, seeds props from x-props JSON', () => {
  const seen: unknown[] = []
  defineBehavior('counter_a1', ({ el, props }) => { seen.push({ tag: el.tagName, props: props() }); return {} })
  html(`<div x-data="counter_a1" x-props='{"n":3}'></div><p x-data="counter_a1"></p>`)
  mount()
  expect(seen).toEqual([{ tag: 'DIV', props: { n: 3 } }, { tag: 'P', props: {} }])
  unmount()
})

test('unknown behavior is requested from the chunk loader once, then mounted', async () => {
  const requested: string[] = []
  setChunkLoader(async (name) => { requested.push(name); defineBehavior(name, () => ({ hello: 'yes' })) })
  html(`<div x-data="lazy_b2"></div><div x-data="lazy_b2"></div>`)
  mount()
  await new Promise((r) => setTimeout(r, 0))
  expect(requested).toEqual(['lazy_b2'])
  unmount()
})

test('disposes on removal, remounts on reinsertion', async () => {
  const log: string[] = []
  defineBehavior('life_c3', ({ effect, onCleanup }) => {
    const s = signal(0)
    effect(() => { s(); log.push('run'); return () => log.push('effect-clean') })
    onCleanup(() => log.push('cleanup'))
    return {}
  })
  const body = html(`<div id="h" x-data="life_c3"></div>`)
  mount()
  const host = body.querySelector('#h')!
  host.remove()
  await new Promise((r) => setTimeout(r, 0))   // MutationObserver is async
  expect(log).toEqual(['run', 'effect-clean', 'cleanup'])
  body.appendChild(host)
  await new Promise((r) => setTimeout(r, 0))
  expect(log).toEqual(['run', 'effect-clean', 'cleanup', 'run'])
  unmount()
})

test('a factory that throws does not break mounting of other hosts', () => {
  defineBehavior('boom_d4', () => { throw new Error('boom') })
  defineBehavior('ok_d4', () => ({ ok: true }))
  html(`<div x-data="boom_d4"></div><div id="ok" x-data="ok_d4"></div>`)
  expect(() => mount()).not.toThrow()
  unmount()
})
```

`test/mount.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { parseValue } from '../src/value'

test('parseValue grammar', () => {
  expect(parseValue('label')).toEqual({ path: ['label'], bindings: [] })
  expect(parseValue('a.b.c')).toEqual({ path: ['a', 'b', 'c'], bindings: [] })
  expect(parseValue('_h2:item')).toEqual({ path: ['_h2'], bindings: ['item'] })
  expect(parseValue('_c1:item,index')).toEqual({ path: ['_c1'], bindings: ['item', 'index'] })
  expect(parseValue('x + 1')).toBeNull()
  expect(parseValue('fn()')).toBeNull()
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/runtime-dom && bun test test/registry.test.ts test/mount.test.ts`
Expected: import failures.

- [ ] **Step 3: Implement**

`src/warn.ts`:

```ts
const seen = new Set<string>()
export function warnOnce(key: string, message: string): void {
  if (seen.has(key)) return
  seen.add(key)
  console.warn(`[brust] ${message}`)
}
```

`src/value.ts`:

```ts
import { isSignal } from './signal'
export interface ParsedValue { path: string[]; bindings: string[] }
const IDENT = /^[A-Za-z_$][\w$]*$/

export function parseValue(raw: string): ParsedValue | null {
  const [pathPart, bindPart, ...rest] = raw.trim().split(':')
  if (rest.length || !pathPart) return null
  const path = pathPart.split('.')
  if (!path.every((p) => IDENT.test(p))) return null
  const bindings = bindPart === undefined ? [] : bindPart.split(',').map((b) => b.trim())
  if (!bindings.every((b) => IDENT.test(b))) return null
  return { path, bindings }
}

export type Scope = Record<string, unknown>

/** Resolve a parsed directive value against instance members. Reads signals (tracked). */
export function resolve(members: Record<string, unknown>, v: ParsedValue, scope: Scope): { ok: true; value: unknown } | { ok: false } {
  let cur: unknown = members
  for (const key of v.path) {
    if (isSignal(cur)) cur = cur()
    if (cur === null || typeof cur !== 'object') return { ok: false }
    if (!(key in (cur as object))) return { ok: false }
    cur = (cur as Record<string, unknown>)[key]
  }
  if (v.bindings.length) {
    if (typeof cur !== 'function') return { ok: false }
    const args = v.bindings.map((b) => scope[b])
    return { ok: true, value: (cur as (...a: unknown[]) => unknown)(...args) }
  }
  if (isSignal(cur)) cur = cur()
  return { ok: true, value: cur }
}

/** Like resolve but returns the member itself (for handlers and x-model signals). */
export function resolveMember(members: Record<string, unknown>, v: ParsedValue): unknown {
  let cur: unknown = members
  for (const key of v.path) {
    if (isSignal(cur)) cur = cur()
    if (cur === null || typeof cur !== 'object' || !(key in (cur as object))) return undefined
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}
```

`src/registry.ts`:

```ts
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
    loader(name).catch((e) => console.error(`[brust] failed to load behavior chunk "${name}"`, e))
  }
}
/** Test helper: forget everything. */
export function _resetRegistry(): void { registry.clear(); waiters.clear(); loader = null; requested.clear() }
```

`src/instance.ts`:

```ts
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
```

`src/directives/index.ts` (walker; the binder table fills in Tasks 3–6):

```ts
import type { Instance } from '../instance'
import type { Scope } from '../value'

export type Binder = (ctx: { inst: Instance; el: Element; attr: string; raw: string; scope: Scope }) => void
/** attribute-name prefix → binder. Exact names first, then prefixes (x-bind-, x-on-). */
export const BINDERS: Array<{ match: (attr: string) => boolean; bind: Binder }> = []

const HOST_ATTR = 'x-data'
/** Install binders for every x-* attribute under `el` (inclusive), not descending into nested hosts. */
export function bindHost(inst: Instance, el: Element, scope: Scope): void {
  bindElement(inst, el, scope)
  walkChildren(inst, el, scope)
}
export function walkChildren(inst: Instance, el: Element, scope: Scope): void {
  for (const child of Array.from(el.children)) {
    if (child.hasAttribute(HOST_ATTR)) continue               // nested host: its own instance binds it
    if (child.hasAttribute('x-for')) { bindElement(inst, child, scope); continue } // x-for owns its subtree
    bindElement(inst, child, scope)
    if (!child.hasAttribute('x-if')) walkChildren(inst, child, scope)   // x-if owns its subtree
  }
}
export function bindElement(inst: Instance, el: Element, scope: Scope): void {
  for (const attr of Array.from(el.attributes)) {
    if (!attr.name.startsWith('x-') || attr.name === HOST_ATTR || attr.name === 'x-props' || attr.name === 'x-props-bind') continue
    const b = BINDERS.find((b) => b.match(attr.name))
    if (b) b.bind({ inst, el, attr: attr.name, raw: attr.value, scope })
  }
}
```

`src/mount.ts`:

```ts
import { Instance } from './instance'
import { whenBehavior } from './registry'
import { bindHost } from './directives/index'
import { warnOnce } from './warn'
import './directives/register'   // Tasks 3–6 add binders here (file created in Task 3; create it empty now)

const instances = new WeakMap<Element, Instance>()
let observer: MutationObserver | null = null

export function instanceOf(el: Element): Instance | undefined { return instances.get(el) }
export function nearestInstance(el: Element): Instance | null {
  let p = el.parentElement
  while (p) { const i = instances.get(p); if (i) return i; p = p.parentElement }
  return null
}

function readProps(host: HTMLElement): Record<string, unknown> {
  const raw = host.getAttribute('x-props')
  if (!raw) return {}
  try { const v = JSON.parse(raw); return v && typeof v === 'object' ? v : {} }
  catch { warnOnce(`props:${host.outerHTML.slice(0, 80)}`, `x-props is not valid JSON on <${host.tagName.toLowerCase()} x-data="${host.getAttribute('x-data')}">`); return {} }
}

function mountHost(host: HTMLElement): void {
  if (instances.has(host) || !host.isConnected) return
  const name = host.getAttribute('x-data')!
  whenBehavior(name, (factory) => {
    if (instances.has(host) || !host.isConnected) return
    const parent = nearestInstance(host)
    const inst = new Instance(host, name, parent, readProps(host))
    instances.set(host, inst)
    try { inst.init(factory) } catch (e) { console.error(`[brust] behavior "${name}" threw during init`, e); return }
    bindHost(inst, host, {})
    bindPropsFromParent(inst)   // Task 6 fills this in; no-op until then
  })
}

export let bindPropsFromParent: (inst: Instance) => void = () => {}
export function _setBindPropsFromParent(f: (inst: Instance) => void): void { bindPropsFromParent = f }

function mountTree(root: ParentNode): void {
  const hosts: HTMLElement[] = []
  if (root instanceof HTMLElement && root.hasAttribute('x-data')) hosts.push(root)
  root.querySelectorAll<HTMLElement>('[x-data]').forEach((h) => hosts.push(h))
  // document order = parents before children, so nearestInstance finds a mounted parent
  for (const h of hosts) mountHost(h)
}
function disposeTree(root: Node): void {
  if (!(root instanceof Element)) return
  const hosts: Element[] = root.hasAttribute('x-data') ? [root] : []
  root.querySelectorAll('[x-data]').forEach((h) => hosts.push(h))
  for (const h of hosts) { const i = instances.get(h); if (i) { i.dispose(); instances.delete(h) } }
}

export function mount(root: ParentNode = document.body): void {
  mountTree(root)
  if (observer) return
  observer = new MutationObserver((records) => {
    for (const r of records) {
      r.removedNodes.forEach((n) => { if (!n.isConnected) disposeTree(n) })
      r.addedNodes.forEach((n) => { if (n instanceof Element && n.isConnected) mountTree(n) })
    }
  })
  observer.observe(root, { childList: true, subtree: true })
}
export function unmount(root: ParentNode = document.body): void {
  observer?.disconnect(); observer = null
  disposeTree(root as Node)
}
```

Create `src/directives/register.ts` as an empty module with a comment (`// binders are registered here by Tasks 3–6`). Update `src/index.ts` to the frozen surface (registry + mount exports).

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/runtime-dom && bun test && bunx tsc --noEmit -p .`
Expected: all pass. The reinsertion test relies on `MutationObserver` delivering after a macrotask in happy-dom; if it is flaky, replace the `setTimeout(0)` with `await new Promise((r) => queueMicrotask(r))` twice and note which one happy-dom needs.

- [ ] **Step 5: Commit**

```bash
git add packages/runtime-dom
git commit -m "feat(runtime-dom): behavior registry, instances, mount/unmount with MutationObserver

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `x-text`, `x-show`, `x-bind-*`, `x-on-*`

**Files:**
- Create: `src/directives/text.ts`, `show.ts`, `bind.ts`, `on.ts`; modify `src/directives/register.ts`; `test/text-show-bind-on.test.ts`

**Interfaces:**
- Consumes: `BINDERS`, `parseValue`, `resolve`, `resolveMember`, `Instance`.
- Produces: the four binders; shared helper `readValue(ctx)` in `src/directives/common.ts` that parses + resolves + warns once on failure and returns `{ ok, value }`.

- [ ] **Step 1: Failing tests**

`test/text-show-bind-on.test.ts`:

```ts
import { expect, test, beforeEach } from 'bun:test'
import { defineBehavior, mount, unmount } from '../src'
import { signal, computed } from '../src/signal'

beforeEach(() => { unmount(); document.body.innerHTML = '' })
const flush = () => new Promise((r) => setTimeout(r, 0))

test('x-text keeps server text until the signal changes, then writes', () => {
  const label = signal('Light')
  defineBehavior('t1', () => ({ label }))
  document.body.innerHTML = `<div x-data="t1"><span id="s" x-text="label">Light</span></div>`
  mount()
  const s = document.getElementById('s')!
  expect(s.textContent).toBe('Light')
  label.set('Dark'); expect(s.textContent).toBe('Dark')
})

test('x-text with a dotted path through a computed', () => {
  const user = signal({ name: 'Ann' })
  defineBehavior('t2', () => ({ user }))
  document.body.innerHTML = `<div x-data="t2"><b id="b" x-text="user.name">Ann</b></div>`
  mount()
  user.set({ name: 'Bob' }); expect(document.getElementById('b')!.textContent).toBe('Bob')
})

test('x-show toggles display', () => {
  const open = signal(false)
  defineBehavior('t3', () => ({ open }))
  document.body.innerHTML = `<div x-data="t3"><p id="p" x-show="open" style="display:none"></p></div>`
  mount()
  const p = document.getElementById('p') as HTMLElement
  expect(p.style.display).toBe('none')
  open.set(true); expect(p.style.display).toBe('')
  open.set(false); expect(p.style.display).toBe('none')
})

test('x-bind-: class, value property, boolean disabled, null removes', () => {
  const cls = signal('a'); const val = signal('x'); const busy = signal(false); const title = signal<string | null>('t')
  defineBehavior('t4', () => ({ cls, val, busy, title }))
  document.body.innerHTML = `<div x-data="t4"><input id="i" class="a" value="x" title="t" x-bind-class="cls" x-bind-value="val" x-bind-disabled="busy" x-bind-title="title"></div>`
  mount()
  const i = document.getElementById('i') as HTMLInputElement
  cls.set('b'); expect(i.className).toBe('b')
  val.set('y'); expect(i.value).toBe('y')
  busy.set(true); expect(i.disabled).toBe(true); expect(i.hasAttribute('disabled')).toBe(true)
  busy.set(false); expect(i.disabled).toBe(false); expect(i.hasAttribute('disabled')).toBe(false)
  title.set(null); expect(i.hasAttribute('title')).toBe(false)
})

test('x-on-click calls the member with the event; item-scoped handler gets bindings first', () => {
  const clicks: unknown[] = []
  defineBehavior('t5', () => ({ hit: (e: Event) => clicks.push(e.type), pick: (item: unknown, e: Event) => clicks.push([item, e.type]) }))
  document.body.innerHTML = `<div x-data="t5"><button id="a" x-on-click="hit"></button></div>`
  mount()
  ;(document.getElementById('a') as HTMLButtonElement).click()
  expect(clicks).toEqual(['click'])
})

test('a typo in a directive value warns once and leaves the DOM alone', () => {
  const warns: string[] = []; const orig = console.warn; console.warn = (m: string) => { warns.push(String(m)) }
  defineBehavior('t6', () => ({ label: signal('ok') }))
  document.body.innerHTML = `<div x-data="t6"><span id="s" x-text="labl">server</span><span x-text="labl"></span></div>`
  expect(() => mount()).not.toThrow()
  expect(document.getElementById('s')!.textContent).toBe('server')
  expect(warns.filter((w) => w.includes('labl')).length).toBe(1)
  console.warn = orig
})

test('x-text initial mismatch is corrected and reported once (compiler-bug tripwire)', () => {
  const warns: string[] = []; const orig = console.warn; console.warn = (m: string) => { warns.push(String(m)) }
  defineBehavior('t7', () => ({ label: computed(() => 'client') }))
  document.body.innerHTML = `<div x-data="t7"><span id="s" x-text="label">server</span></div>`
  mount()
  expect(document.getElementById('s')!.textContent).toBe('client')
  expect(warns.some((w) => w.includes('mismatch'))).toBe(true)
  console.warn = orig
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/runtime-dom && bun test test/text-show-bind-on.test.ts`
Expected: assertions fail (no binders registered).

- [ ] **Step 3: Implement**

`src/directives/common.ts`:

```ts
import { parseValue, resolve, resolveMember, type ParsedValue, type Scope } from '../value'
import { warnOnce } from '../warn'
import type { Instance } from '../instance'

export function parsed(inst: Instance, attr: string, raw: string): ParsedValue | null {
  const p = parseValue(raw)
  if (!p) warnOnce(`parse:${inst.name}:${attr}:${raw}`, `${attr}="${raw}" on x-data="${inst.name}" is not a member path (expressions are not allowed)`)
  return p
}
export function read(inst: Instance, p: ParsedValue, scope: Scope, attr: string): { ok: boolean; value: unknown } {
  const r = resolve(inst.members, p, scope)
  if (!r.ok) warnOnce(`missing:${inst.name}:${attr}:${p.path.join('.')}`, `${attr}="${p.path.join('.')}" on x-data="${inst.name}": no such member`)
  return r.ok ? r : { ok: false, value: undefined }
}
export function member(inst: Instance, p: ParsedValue, attr: string): unknown {
  const m = resolveMember(inst.members, p)
  if (m === undefined) warnOnce(`missing:${inst.name}:${attr}:${p.path.join('.')}`, `${attr}="${p.path.join('.')}" on x-data="${inst.name}": no such member`)
  return m
}
export function mismatch(inst: Instance, attr: string, el: Element, server: unknown, client: unknown): void {
  warnOnce(`mismatch:${inst.name}:${attr}`, `first-paint mismatch on <${el.tagName.toLowerCase()} ${attr}> in x-data="${inst.name}": server=${JSON.stringify(server)} client=${JSON.stringify(client)} (compiler bug: §6.3)`)
}
```

`src/directives/text.ts`:

```ts
import { BINDERS } from './index'
import { parsed, read, mismatch } from './common'
BINDERS.push({
  match: (a) => a === 'x-text',
  bind: ({ inst, el, attr, raw, scope }) => {
    const p = parsed(inst, attr, raw); if (!p) return
    let first = true
    inst.effect(() => {
      const r = read(inst, p, scope, attr); if (!r.ok) return
      const next = r.value == null ? '' : String(r.value)
      if (first) { first = false; if (el.textContent !== next) { mismatch(inst, attr, el, el.textContent, next); el.textContent = next }; return }
      el.textContent = next
    })
  },
})
```

`src/directives/show.ts`:

```ts
import { BINDERS } from './index'
import { parsed, read } from './common'
BINDERS.push({
  match: (a) => a === 'x-show',
  bind: ({ inst, el, attr, raw, scope }) => {
    const p = parsed(inst, attr, raw); if (!p) return
    inst.effect(() => {
      const r = read(inst, p, scope, attr); if (!r.ok) return
      ;(el as HTMLElement).style.display = r.value ? '' : 'none'
    })
  },
})
```

`src/directives/bind.ts`:

```ts
import { BINDERS } from './index'
import { parsed, read } from './common'
const BOOLEAN = new Set(['disabled', 'checked', 'selected', 'readonly', 'required', 'hidden', 'open', 'multiple'])
BINDERS.push({
  match: (a) => a.startsWith('x-bind-'),
  bind: ({ inst, el, attr, raw, scope }) => {
    const name = attr.slice('x-bind-'.length)
    const p = parsed(inst, attr, raw); if (!p) return
    inst.effect(() => {
      const r = read(inst, p, scope, attr); if (!r.ok) return
      const v = r.value
      if (name === 'class') { (el as HTMLElement).className = v == null ? '' : String(v); return }
      if (name === 'value' && 'value' in el) { (el as HTMLInputElement).value = v == null ? '' : String(v); return }
      if (BOOLEAN.has(name)) {
        const on = Boolean(v)
        if (name in el) (el as unknown as Record<string, unknown>)[name] = on
        if (on) el.setAttribute(name, '') ; else el.removeAttribute(name)
        return
      }
      if (v == null || v === false) el.removeAttribute(name); else el.setAttribute(name, String(v))
    })
  },
})
```

`src/directives/on.ts`:

```ts
import { BINDERS } from './index'
import { parsed, member } from './common'
BINDERS.push({
  match: (a) => a.startsWith('x-on-'),
  bind: ({ inst, el, attr, raw, scope }) => {
    const event = attr.slice('x-on-'.length)
    const p = parsed(inst, attr, raw); if (!p) return
    const handler = (e: Event) => {
      const fn = member(inst, p, attr)
      if (typeof fn !== 'function') return
      const args = p.bindings.map((b) => scope[b])
      ;(fn as (...a: unknown[]) => void)(...args, e)
    }
    el.addEventListener(event, handler)
    inst.onCleanup(() => el.removeEventListener(event, handler))
  },
})
```

`src/directives/register.ts`:

```ts
import './text'
import './show'
import './bind'
import './on'
```

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/runtime-dom && bun test && bunx tsc --noEmit -p .`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/runtime-dom
git commit -m "feat(runtime-dom): x-text, x-show, x-bind-*, x-on-* binders

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `x-if` and `x-model`

**Files:**
- Create: `src/directives/if.ts`, `src/directives/model.ts`; modify `register.ts`; `test/if-model.test.ts`

**Interfaces:**
- Produces: `x-if` mounts/unmounts a clone of the element (a comment anchor marks the place; nested hosts inside the clone mount through the observer); `x-model` two-way binds a **signal** member for text-like inputs (`input` event), checkbox (boolean `checked`, `change`), radio group (writes `value` when checked), single `select` (re-applies after children change).

- [ ] **Step 1: Failing tests**

`test/if-model.test.ts`:

```ts
import { expect, test, beforeEach } from 'bun:test'
import { defineBehavior, mount, unmount } from '../src'
import { signal } from '../src/signal'
beforeEach(() => { unmount(); document.body.innerHTML = '' })
const flush = () => new Promise((r) => setTimeout(r, 0))

test('x-if removes/mounts the element and its subtree; nested host mounts inside', async () => {
  const open = signal(true); const inits: string[] = []
  defineBehavior('i1', () => ({ open }))
  defineBehavior('inner_i1', ({ el }) => { inits.push(el.id); return {} })
  document.body.innerHTML = `<div x-data="i1"><section id="s" x-if="open"><div id="k" x-data="inner_i1"></div></section></div>`
  mount(); await flush()
  expect(document.getElementById('s')).not.toBeNull(); expect(inits).toEqual(['k'])
  open.set(false); await flush()
  expect(document.getElementById('s')).toBeNull()
  open.set(true); await flush()
  expect(document.getElementById('s')).not.toBeNull(); expect(inits).toEqual(['k', 'k'])
})

test('x-if false on first paint: server omitted the element, runtime keeps it out', () => {
  const open = signal(false)
  defineBehavior('i2', () => ({ open }))
  document.body.innerHTML = `<div x-data="i2"><!--x-if--><p id="p" x-if="open" hidden></p></div>`
  mount()
  expect(document.getElementById('p')).toBeNull()
})

test('x-model text input: input event writes the signal, signal writes the value', () => {
  const q = signal('a')
  defineBehavior('m1', () => ({ q }))
  document.body.innerHTML = `<div x-data="m1"><input id="i" x-model="q" value="a"></div>`
  mount()
  const i = document.getElementById('i') as HTMLInputElement
  i.value = 'ab'; i.dispatchEvent(new Event('input', { bubbles: true }))
  expect(q()).toBe('ab')
  q.set('z'); expect(i.value).toBe('z')
})

test('x-model checkbox is boolean; radio group writes value', () => {
  const on = signal(false); const color = signal('red')
  defineBehavior('m2', () => ({ on, color }))
  document.body.innerHTML = `<div x-data="m2"><input id="c" type="checkbox" x-model="on"><input id="r1" type="radio" name="c" value="red" x-model="color" checked><input id="r2" type="radio" name="c" value="blue" x-model="color"></div>`
  mount()
  const c = document.getElementById('c') as HTMLInputElement
  c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); expect(on()).toBe(true)
  const r2 = document.getElementById('r2') as HTMLInputElement
  r2.checked = true; r2.dispatchEvent(new Event('change', { bubbles: true })); expect(color()).toBe('blue')
  color.set('red'); expect((document.getElementById('r1') as HTMLInputElement).checked).toBe(true)
})

test('x-model select re-applies the value after options change', async () => {
  const sel = signal('b'); const opts = signal(['a'])
  defineBehavior('m3', () => ({ sel, opts, key: (o: string) => o }))
  document.body.innerHTML = `<div x-data="m3"><select id="s" x-model="sel"><option x-for="o in opts by key" x-bind-value="o" x-text="o">a</option></select></div>`
  mount(); await flush()
  opts.set(['a', 'b']); await flush()
  expect((document.getElementById('s') as HTMLSelectElement).value).toBe('b')
})

test('x-model on a non-signal member warns and does nothing', () => {
  const warns: string[] = []; const orig = console.warn; console.warn = (m: string) => { warns.push(String(m)) }
  defineBehavior('m4', () => ({ q: 'plain' }))
  document.body.innerHTML = `<div x-data="m4"><input x-model="q"></div>`
  mount()
  expect(warns.some((w) => w.includes('x-model') && w.includes('signal'))).toBe(true)
  console.warn = orig
})
```

The select test depends on `x-for` (Task 5); mark it `test.todo` until Task 5 lands, then un-todo it in Task 5.

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/runtime-dom && bun test test/if-model.test.ts`

- [ ] **Step 3: Implement**

`src/directives/if.ts`:

```ts
import { BINDERS, bindElement, walkChildren } from './index'
import { parsed, read } from './common'
BINDERS.push({
  match: (a) => a === 'x-if',
  bind: ({ inst, el, attr, raw, scope }) => {
    const p = parsed(inst, attr, raw); if (!p) return
    const anchor = document.createComment('x-if')
    const template = el.cloneNode(true) as Element
    template.removeAttribute('x-if')
    el.replaceWith(anchor)                 // the server-rendered element becomes the first clone below
    let current: Element | null = null
    inst.effect(() => {
      const r = read(inst, p, scope, attr); if (!r.ok) return
      const want = Boolean(r.value)
      if (want && !current) {
        current = template.cloneNode(true) as Element
        anchor.after(current)
        bindElement(inst, current, scope); walkChildren(inst, current, scope)
      } else if (!want && current) {
        current.remove(); current = null   // the observer disposes nested hosts
      }
    })
    inst.onCleanup(() => { current?.remove() })
  },
})
```

Note the first-paint rule: the server renders the element when the condition is true; the binder replaces it with a fresh clone on mount (the clone is identical, so nothing visible changes) — simpler than adopting the live element and keeps `template` pristine. Nested `x-data` hosts inside the clone are mounted by the `MutationObserver`.

`src/directives/model.ts`:

```ts
import { BINDERS } from './index'
import { parsed, member } from './common'
import { isSignal, type Signal } from '../signal'
import { warnOnce } from '../warn'
BINDERS.push({
  match: (a) => a === 'x-model',
  bind: ({ inst, el, attr, raw }) => {
    const p = parsed(inst, attr, raw); if (!p) return
    const sig = member(inst, p, attr)
    if (!isSignal(sig) || typeof (sig as Signal<unknown>).set !== 'function') {
      warnOnce(`model:${inst.name}:${raw}`, `x-model="${raw}" on x-data="${inst.name}" must name a writable signal`); return
    }
    const s = sig as Signal<unknown>
    const input = el as HTMLInputElement
    const type = input.type
    if (input instanceof HTMLInputElement && type === 'checkbox') {
      const h = () => s.set(input.checked); el.addEventListener('change', h); inst.onCleanup(() => el.removeEventListener('change', h))
      inst.effect(() => { input.checked = Boolean(s()) })
    } else if (input instanceof HTMLInputElement && type === 'radio') {
      const h = () => { if (input.checked) s.set(input.value) }; el.addEventListener('change', h); inst.onCleanup(() => el.removeEventListener('change', h))
      inst.effect(() => { input.checked = s() === input.value })
    } else if (el instanceof HTMLSelectElement) {
      if (el.multiple) { warnOnce(`model:multi:${inst.name}`, `x-model on select[multiple] is not supported`); return }
      const h = () => s.set(el.value); el.addEventListener('change', h); inst.onCleanup(() => el.removeEventListener('change', h))
      const apply = () => { const v = s(); if (el.value !== String(v)) el.value = String(v ?? '') }
      inst.effect(apply)
      const mo = new MutationObserver(() => apply()); mo.observe(el, { childList: true }); inst.onCleanup(() => mo.disconnect())
    } else {
      const h = () => s.set(input.value); el.addEventListener('input', h); inst.onCleanup(() => el.removeEventListener('input', h))
      inst.effect(() => { const v = s(); if (input.value !== String(v ?? '')) input.value = String(v ?? '') })
    }
  },
})
```

Add `import './if'` and `import './model'` to `register.ts`.

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/runtime-dom && bun test && bunx tsc --noEmit -p .`

- [ ] **Step 5: Commit**

```bash
git add packages/runtime-dom
git commit -m "feat(runtime-dom): x-if and x-model

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: `x-for` keyed lists with item scope

**Files:**
- Create: `src/directives/for.ts`; modify `register.ts`; `test/for.test.ts`; un-todo the select test in `test/if-model.test.ts`

**Interfaces:**
- Produces: `x-for="item in source by keyFn"` and `x-for="item, index in source by keyFn"`; `source` is a member path (array, signal or computed of array); `keyFn` is a member (function of item) — the compiler emits `_kN = (item) => item.id`. Each rendered row binds the element's other directives with scope `{ [item]: value, [index]: i }`, so `x-text="_c2:item"` works. Nested hosts inside rows mount through the observer.

- [ ] **Step 1: Failing tests**

`test/for.test.ts`:

```ts
import { expect, test, beforeEach } from 'bun:test'
import { defineBehavior, mount, unmount } from '../src'
import { signal } from '../src/signal'
beforeEach(() => { unmount(); document.body.innerHTML = '' })
const texts = () => Array.from(document.querySelectorAll('li')).map((l) => l.textContent)

test('renders rows from the server, reconciles by key: insert, remove, reorder keep DOM identity', () => {
  const items = signal([{ id: 1, n: 'a' }, { id: 2, n: 'b' }])
  defineBehavior('f1', () => ({ items, key: (i: { id: number }) => i.id, name: (i: { n: string }) => i.n }))
  document.body.innerHTML = `<ul x-data="f1"><li x-for="item in items by key" x-text="name:item">a</li><li x-for="item in items by key" x-text="name:item">b</li></ul>`
  mount()
  expect(texts()).toEqual(['a', 'b'])
  const first = document.querySelector('li')!
  items.set([{ id: 2, n: 'b' }, { id: 1, n: 'a' }, { id: 3, n: 'c' }])
  expect(texts()).toEqual(['b', 'a', 'c'])
  expect(document.querySelectorAll('li')[1]).toBe(first)        // moved, not recreated
  items.set([{ id: 3, n: 'c' }])
  expect(texts()).toEqual(['c'])
})

test('index binding and item-scoped handler', () => {
  const picks: unknown[] = []
  const items = signal(['x', 'y'])
  defineBehavior('f2', () => ({ items, key: (s: string) => s, label: (s: string, i: number) => `${i}:${s}`, pick: (s: string, i: number, e: Event) => picks.push([s, i, e.type]) }))
  document.body.innerHTML = `<ul x-data="f2"><li x-for="item, index in items by key" x-text="label:item,index" x-on-click="pick:item,index"></li></ul>`
  mount()
  expect(texts()).toEqual(['0:x', '1:y'])
  ;(document.querySelectorAll('li')[1] as HTMLElement).click()
  expect(picks).toEqual([['y', 1, 'click']])
})

test('duplicate keys warn once and fall back to index identity (no infinite loop, no dropped rows)', () => {
  const warns: string[] = []; const orig = console.warn; console.warn = (m: string) => { warns.push(String(m)) }
  const items = signal([{ id: 1 }, { id: 1 }, { id: 2 }])
  defineBehavior('f3', () => ({ items, key: (i: { id: number }) => i.id, show: (i: { id: number }) => String(i.id) }))
  document.body.innerHTML = `<ul x-data="f3"><li x-for="item in items by key" x-text="show:item"></li></ul>`
  mount()
  expect(texts()).toEqual(['1', '1', '2'])
  items.set([{ id: 1 }, { id: 1 }])
  expect(texts()).toEqual(['1', '1'])
  expect(warns.filter((w) => w.includes('duplicate key')).length).toBe(1)
  console.warn = orig
})

test('server rendered zero rows: the x-for template is still found via the comment marker', () => {
  const items = signal<string[]>([])
  defineBehavior('f4', () => ({ items, key: (s: string) => s, t: (s: string) => s }))
  document.body.innerHTML = `<ul x-data="f4"><!--x-for--><li x-for="item in items by key" x-text="t:item" hidden></li></ul>`
  mount()
  expect(texts()).toEqual([])
  items.set(['a']); expect(texts()).toEqual(['a'])
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/runtime-dom && bun test test/for.test.ts`

- [ ] **Step 3: Implement `src/directives/for.ts`**

```ts
import { BINDERS, bindElement, walkChildren } from './index'
import { parsed, read, member } from './common'
import { warnOnce } from '../warn'
import type { Instance } from '../instance'

const SYNTAX = /^\s*([A-Za-z_$][\w$]*)\s*(?:,\s*([A-Za-z_$][\w$]*))?\s+in\s+([A-Za-z_$][\w$.]*)\s+by\s+([A-Za-z_$][\w$.]*)\s*$/
const done = new WeakSet<Element>()

BINDERS.push({
  match: (a) => a === 'x-for',
  bind: ({ inst, el, attr, raw, scope }) => {
    if (done.has(el)) return
    const m = SYNTAX.exec(raw)
    if (!m) { warnOnce(`for:${inst.name}:${raw}`, `x-for="${raw}" on x-data="${inst.name}": expected "item[, index] in source by keyFn"`); return }
    const [, itemName, indexName, sourcePath, keyPath] = m as unknown as [string, string, string | undefined, string, string]
    const src = parsed(inst, attr, sourcePath)!; const keyP = parsed(inst, attr, keyPath)!

    // All server-rendered siblings carrying the same x-for are rows of this list; the first is the template.
    const parent = el.parentElement!
    const siblings = Array.from(parent.children).filter((c) => c.getAttribute('x-for') === raw)
    siblings.forEach((s) => done.add(s))
    const template = el.cloneNode(true) as Element
    template.removeAttribute('x-for'); template.removeAttribute('hidden')
    const anchor = document.createComment('x-for')
    parent.insertBefore(anchor, el)
    for (const s of siblings) s.remove()     // rows are re-created from the template so scope binding is uniform

    type Row = { el: Element; sub: Instance | null }
    let rows = new Map<unknown, Element[]>()  // key -> elements (array to tolerate duplicates)
    let order: Element[] = []

    inst.effect(() => {
      const r = read(inst, src, scope, attr); if (!r.ok) return
      const list = Array.isArray(r.value) ? (r.value as unknown[]) : []
      const keyFn = member(inst, keyP, attr)
      if (typeof keyFn !== 'function') return
      const next = new Map<unknown, Element[]>(); const nextOrder: Element[] = []
      const seen = new Set<unknown>()
      list.forEach((item, i) => {
        let key = (keyFn as (x: unknown) => unknown)(item)
        if (seen.has(key)) { warnOnce(`for:dupkey:${inst.name}:${raw}`, `x-for on x-data="${inst.name}": duplicate key ${JSON.stringify(key)}; falling back to index identity`); key = `__dup_${i}` }
        seen.add(key)
        const pool = rows.get(key)
        let node = pool?.shift()
        if (!node) {
          node = template.cloneNode(true) as Element
          const rowScope = { ...scope, [itemName]: item, ...(indexName ? { [indexName]: i } : {}) }
          bindElement(inst, node, rowScope); walkChildren(inst, node, rowScope)
          ;(node as unknown as { __scope: Record<string, unknown> }).__scope = rowScope
        } else {
          // existing row: refresh scope values in place (binders read scope lazily through effects)
          const rs = (node as unknown as { __scope: Record<string, unknown> }).__scope
          rs[itemName] = item; if (indexName) rs[indexName] = i
        }
        ;(next.get(key) ?? next.set(key, []).get(key)!).push(node)
        nextOrder.push(node)
      })
      for (const [, pool] of rows) for (const stale of pool) stale.remove()
      // place in order after the anchor
      let ref: Node = anchor
      for (const node of nextOrder) { if (ref.nextSibling !== node) parent.insertBefore(node, ref.nextSibling); ref = node }
      rows = next; order = nextOrder
    })
    inst.onCleanup(() => { for (const n of order) n.remove() })
  },
})
```

Scope refresh on existing rows: binders captured the `rowScope` object by reference; writing new values into it is not reactive by itself, so after refreshing scope the effect must re-run the row's binders. Simplest correct approach: make each row scope value a signal — change `rowScope` to `{ [itemName]: signal(item) }` **only if** `resolve` unwraps signals in scope. Decide one of the two and keep it consistent: this plan chooses **re-binding on change** — if the item value is not `Object.is` the previous one, remove the stale node and create a fresh one (DOM identity is only preserved when the item is identical or when the key maps to an unchanged object). Implement that by comparing `rs[itemName]` with `item` and treating a changed item as a new row (remove + clone). The reorder test uses identical objects for moved rows, so it still passes.

Add `import './for'` to `register.ts`; un-todo the select test in `test/if-model.test.ts`.

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/runtime-dom && bun test && bunx tsc --noEmit -p .`

- [ ] **Step 5: Commit**

```bash
git add packages/runtime-dom
git commit -m "feat(runtime-dom): keyed x-for with item/index scope

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: `x-ref` and reactive props (`x-props-bind`)

**Files:**
- Create: `src/directives/ref.ts`, `src/props-bind.ts`; modify `src/mount.ts` (`bindPropsFromParent`), `register.ts`; `test/ref-props-bind.test.ts`

**Interfaces:**
- Produces: `x-ref="name"` fills `ctx.ref('name').current` after mount (and nulls it on dispose); `x-props-bind="member[:binding]"` on a child host binds the child's `props` signal to the nearest ancestor instance's member (a computed returning the props object; functions allowed), re-evaluated reactively; waits for the parent if it is not mounted yet.

- [ ] **Step 1: Failing tests**

`test/ref-props-bind.test.ts`:

```ts
import { expect, test, beforeEach } from 'bun:test'
import { defineBehavior, mount, unmount } from '../src'
import { signal, computed } from '../src/signal'
beforeEach(() => { unmount(); document.body.innerHTML = '' })
const flush = () => new Promise((r) => setTimeout(r, 0))

test('x-ref fills ref.current after mount and nulls it on dispose', async () => {
  let r: { current: HTMLElement | null } | null = null
  defineBehavior('r1', ({ ref }) => { r = ref('box'); expect(r.current).toBeNull(); return {} })
  document.body.innerHTML = `<div id="h" x-data="r1"><p id="p" x-ref="box"></p></div>`
  mount()
  expect(r!.current).toBe(document.getElementById('p'))
  document.getElementById('h')!.remove(); await flush()
  expect(r!.current).toBeNull()
})

test('x-props-bind: child props follow parent state, functions pass through, SSR seed untouched until change', () => {
  const count = signal(0); const resets: number[] = []
  defineBehavior('parent_p1', () => ({ count, _p1: computed(() => ({ n: count(), onReset: () => resets.push(count()) })) }))
  defineBehavior('child_p1', ({ props }) => ({ _c1: computed(() => props().n), _h1: (e: Event) => (props().onReset as () => void)() }))
  document.body.innerHTML = `<div x-data="parent_p1"><button id="c" x-data="child_p1" x-props='{"n":0}' x-props-bind="_p1" x-on-click="_h1" x-text="_c1">0</button></div>`
  mount()
  const c = document.getElementById('c') as HTMLButtonElement
  expect(c.textContent).toBe('0')
  count.set(5); expect(c.textContent).toBe('5')
  c.click(); expect(resets).toEqual([5])
})

test('x-props-bind inside x-for passes the item binding', () => {
  const items = signal([{ id: 1, n: 'a' }, { id: 2, n: 'b' }])
  defineBehavior('parent_p2', () => ({ items, key: (i: { id: number }) => i.id, _p1: (item: { n: string }) => ({ name: item.n }) }))
  defineBehavior('row_p2', ({ props }) => ({ _c1: computed(() => props().name) }))
  document.body.innerHTML = `<ul x-data="parent_p2"><li x-for="item in items by key" x-data="row_p2" x-props-bind="_p1:item" x-text="_c1"></li></ul>`
  mount()
  expect(Array.from(document.querySelectorAll('li')).map((l) => l.textContent)).toEqual(['a', 'b'])
})

test('child mounted before its parent chunk arrives waits, then binds', async () => {
  const { setChunkLoader } = await import('../src')
  const count = signal(1)
  defineBehavior('child_p3', ({ props }) => ({ _c1: computed(() => props().n) }))
  setChunkLoader(async (name) => { if (name === 'late_parent_p3') defineBehavior(name, () => ({ _p1: computed(() => ({ n: count() })) })) })
  document.body.innerHTML = `<div x-data="late_parent_p3"><span id="s" x-data="child_p3" x-props='{"n":1}' x-props-bind="_p1" x-text="_c1">1</span></div>`
  mount(); await flush()
  count.set(2); expect(document.getElementById('s')!.textContent).toBe('2')
})

test('x-props-bind with no ancestor instance warns and keeps the JSON seed', () => {
  const warns: string[] = []; const orig = console.warn; console.warn = (m: string) => { warns.push(String(m)) }
  defineBehavior('orphan_p4', ({ props }) => ({ _c1: computed(() => props().n) }))
  document.body.innerHTML = `<span id="s" x-data="orphan_p4" x-props='{"n":7}' x-props-bind="_p1" x-text="_c1">7</span>`
  mount()
  expect(document.getElementById('s')!.textContent).toBe('7')
  expect(warns.some((w) => w.includes('x-props-bind'))).toBe(true)
  console.warn = orig
})
```

Note: in the x-for + child-host test the `<li>` carries both `x-for` and `x-data`. The walker must treat such an element as an x-for template first; the cloned rows then carry `x-data` and are mounted by the observer **with the row scope available**. To pass the row scope to the child's `x-props-bind`, `for.ts` stores `__scope` on the row element (already does) and `props-bind.ts` reads `__scope` from the host or its nearest ancestor that has one.

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/runtime-dom && bun test test/ref-props-bind.test.ts`

- [ ] **Step 3: Implement**

`src/directives/ref.ts`:

```ts
import { BINDERS } from './index'
BINDERS.push({
  match: (a) => a === 'x-ref',
  bind: ({ inst, el, raw }) => {
    const r = inst.ref(raw.trim())
    r.current = el
    inst.onCleanup(() => { if (r.current === el) r.current = null })
  },
})
```

`src/props-bind.ts`:

```ts
import type { Instance } from './instance'
import { parseValue, resolve } from './value'
import { warnOnce } from './warn'
import { nearestInstance, _setBindPropsFromParent } from './mount'

function scopeOf(el: Element): Record<string, unknown> {
  let e: Element | null = el
  while (e) { const s = (e as unknown as { __scope?: Record<string, unknown> }).__scope; if (s) return s; e = e.parentElement }
  return {}
}

_setBindPropsFromParent((inst: Instance) => {
  const raw = inst.host.getAttribute('x-props-bind'); if (!raw) return
  const p = parseValue(raw)
  if (!p) { warnOnce(`pb:parse:${inst.name}`, `x-props-bind="${raw}" on x-data="${inst.name}" is not a member path`); return }
  const parent = inst.parent ?? nearestInstance(inst.host)
  if (!parent) { warnOnce(`pb:orphan:${inst.name}`, `x-props-bind="${raw}" on x-data="${inst.name}": no ancestor x-data instance; keeping x-props seed`); return }
  const scope = scopeOf(inst.host)
  inst.effect(() => {
    const r = resolve(parent.members, p, scope)
    if (!r.ok) { warnOnce(`pb:missing:${inst.name}`, `x-props-bind="${raw}": parent x-data="${parent.name}" has no such member`); return }
    const v = r.value
    if (v && typeof v === 'object') inst.props.set(v as Record<string, unknown>)
  })
})
```

Mount-order guarantee (Review Focus 3): `mountHost` resolves the parent with `nearestInstance` at the time the child's factory runs; when the parent chunk arrives later, the parent's `mountHost` runs after the child's — so in `mount.ts`, after a parent instance is created, re-run `bindPropsFromParent` for every already-mounted descendant host whose `inst.parent` is null:

```ts
// in mountHost, after bindHost(inst, host, {}):
host.querySelectorAll<HTMLElement>('[x-data][x-props-bind]').forEach((h) => {
  const child = instances.get(h)
  if (child && !child.parent) { child.parent = inst; inst.children.add(child); bindPropsFromParent(child) }
})
```

And `mount.ts` must `import './props-bind'` after `_setBindPropsFromParent` is defined (put the import at the bottom of `mount.ts`, or register from `directives/register.ts`). Add `import './ref'` to `register.ts`.

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/runtime-dom && bun test && bunx tsc --noEmit -p .`

- [ ] **Step 5: Commit**

```bash
git add packages/runtime-dom
git commit -m "feat(runtime-dom): x-ref and reactive parent→child props via x-props-bind

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Build, react-freedom gate, directive contract doc

**Files:**
- Create: `packages/runtime-dom/scripts/build.ts`, `packages/runtime-dom/README.md`, `test/build.test.ts`
- Modify: `.github/workflows/ci.yml` (add a `runtime-dom` job), root `README.md` (one line)

- [ ] **Step 1: Failing test**

`test/build.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

test('bun build produces a react-free ESM bundle under 12 KB (minified)', () => {
  const r = spawnSync('bun', ['scripts/build.ts'], { cwd: import.meta.dir + '/..', encoding: 'utf8' })
  expect(r.status).toBe(0)
  const out = import.meta.dir + '/../dist/index.js'
  expect(existsSync(out)).toBe(true)
  const src = readFileSync(out, 'utf8')
  expect(src.includes('from "react')).toBe(false)
  expect(src.includes('react/jsx-runtime')).toBe(false)
  expect(statSync(out).size).toBeLessThan(12 * 1024)
})
```

- [ ] **Step 2: Implement `scripts/build.ts`**

```ts
import { readFileSync, statSync } from 'node:fs'
const result = await Bun.build({
  entrypoints: ['./src/index.ts'], outdir: './dist', format: 'esm', target: 'browser', minify: true, sourcemap: 'external',
})
if (!result.success) { for (const l of result.logs) console.error(l); process.exit(1) }
const js = readFileSync('./dist/index.js', 'utf8')
if (/from\s*["']react/.test(js) || js.includes('react/jsx-runtime')) { console.error('[build] react leaked into runtime-dom'); process.exit(1) }
console.log(`[build] dist/index.js ${statSync('./dist/index.js').size} bytes`)
```

Add `dist/` to `.gitignore`.

- [ ] **Step 3: README — the directive contract**

`packages/runtime-dom/README.md` documents, as the output format M1c prints: the value grammar; every attribute with its exact semantics as implemented (one subsection each: `x-data`, `x-props`, `x-props-bind`, `x-text`, `x-show`, `x-if` (comment anchor, clone), `x-bind-<attr>` (class/value/boolean table), `x-on-<event>` (bindings then event), `x-model` (per input kind), `x-for` (syntax, key fn, template marker `<!--x-for-->` when zero rows, duplicate-key fallback, identity rule), `x-ref`); the mount lifecycle (document order, observer, dispose); the chunk loader (`setChunkLoader`, default none); the first-paint rule and the mismatch warning. Write it from the test files — every behaviour in the README must have a test.

- [ ] **Step 4: CI job**

Append to `.github/workflows/ci.yml`:

```yaml
  runtime-dom:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: "1.4.2" }
      - run: bun install --frozen-lockfile
      - run: bunx tsc --noEmit -p packages/runtime-dom
      - run: cd packages/runtime-dom && bun test
      - run: cd packages/runtime-dom && bun scripts/build.ts
```

- [ ] **Step 5: Run everything, commit, open the PR**

```bash
cd packages/runtime-dom && bun test && bunx tsc --noEmit -p . && bun scripts/build.ts
git add packages/runtime-dom .github/workflows/ci.yml .gitignore README.md
git commit -m "feat(runtime-dom): build + react-freedom gate, directive contract README, CI job

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Open a PR `lane/m1d-runtime-dom -> v2`; CI must be green (both jobs).

---

## Self-review notes

- **Spec coverage:** §7.1 chunk shape (what the runtime must accept: `defineBehavior`, members, `_hN`, `props()` as a signal) → Tasks 2, 3, 6; §7.2 every directive incl. the three additions (`x-ref`, `member:binding`, `x-props-bind`, `ctx.ref`, `props` signal) → Tasks 3–6; §7.4 → Task 6 (plain + item-scoped + functions + late parent); §6.3 first-paint rule → Task 3 mismatch tripwire; §11 runtime-dom tests + react-freedom → Tasks 1–7; D7 eval-free → `value.ts` grammar test (Task 2).
- **Type consistency:** `BehaviorCtx`, `Instance.effect/onCleanup/ref`, `BINDERS`, `bindElement/walkChildren`, `parseValue/resolve/resolveMember`, `_setBindPropsFromParent/nearestInstance` are used with the same names across Tasks 2–6.
- **Review Focus → tests:** 1 → Task 2 `disposes on removal, remounts on reinsertion`; 2 → Task 5 duplicate keys; 3 → Task 6 late parent; 4 → Task 4 select re-apply; 5 → Task 3 typo warning.
- **Known soft spots:** happy-dom's `MutationObserver` timing (Task 2 Step 4 says what to try); `x-for` row identity rule when the item object changes (Task 5 Step 3 chose "changed item = new row" — the compiler always passes fresh arrays from `.map`, so identity-preserving moves only matter for reorder of unchanged objects, which is the test).

## Dispatch table (for the Coordinator)

Branch `v2`. Lanes branch from `v2`; the lead creates the worktree.

| slug | plan tasks | tier | role | deps | review | acceptance (READY evidence) |
|---|---|---|---|---|---|---|
| `m1d-runtime-dom` | 1–7 | standard | Implementer (Standard) — the plan carries the code; the reviewer is Complex because the mount lifecycle and the parent→child link are shared-interface surface | — | complex | `cd packages/runtime-dom && bun test` all green (paste counts per file); `bunx tsc --noEmit -p packages/runtime-dom` clean; `bun scripts/build.ts` prints the byte size (< 12 KB) and the react-freedom check passes; PR `lane/m1d-runtime-dom -> v2` with both CI jobs green (URL); lane HEAD sha. |

Gate commands the Runner may execute: `cd packages/runtime-dom && bun test`, `bunx tsc --noEmit -p packages/runtime-dom`, `cd packages/runtime-dom && bun scripts/build.ts`.
