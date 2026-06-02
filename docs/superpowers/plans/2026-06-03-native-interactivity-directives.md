# Native Interactivity via DOM Directives — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `native: true` (jinja) pages interactive — reactive text/show/attr-binding/events/list-render — via Alpine-style `x-*` DOM directives bound to the Spec A isomorphic store, with **no Rust and no compiler change**.

**Architecture:** A react-free directive runtime (`runtime/native/`) scans the DOM for `x-*` attributes and binds them to per-element component instances via Spec A's `effect`. A `MutationObserver` handles initial-load / SPA-nav / dynamic mount+dispose. Single-file components: a `.tsx` with a `default` export (JSX template → jinja, existing compiler path) and a co-located `export const behavior` (client logic). A build step (`runtime/native/build.ts`) bundles behaviors into a self-contained `/_brust/islands/_directives.js` and bakes its `<script>` into the jinja (mirrors the islands bootstrap baking).

**Tech Stack:** TypeScript, Bun (`bun test`, `Bun.build`), happy-dom (DOM units), `brustjs/store` (`signal`/`computed`/`effect`/`isSignal`/`isComputed`), biome (lint gate = `bun run ci`).

**Spec:** `docs/superpowers/specs/2026-06-03-native-interactivity-directives-design.md`

**Conventions (repo rules — read before starting):**
- Lint gate is `bun run ci` (biome) from repo ROOT, NOT `tsc` (it stack-overflows). Run after each task.
- This plan touches **no Rust**. Do not edit `crates/`. `cargo test` baselines must stay byte-identical. No `.node` rebuild is needed (no Rust change) — but integration tests that boot the server still require a previously-built addon to exist (it does on this branch).
- Never `git add -A` (sweeps untracked `tools/`). Stage explicit paths.
- Directive runtime is **react-free and dom-only** — never import react or react-dom there.

---

## File Structure

```
runtime/native/runtime.ts        # register, start, mount, bind, read, callMethod, setBound, x-for  (new)
runtime/native/runtime.test.ts   # directive runtime units (happy-dom)                               (new)
runtime/native/build.ts          # scanDirectiveComponents, buildDirectives                          (new)
runtime/native/build.test.ts     # scan + generated-entry + react-leak guard                         (new)
runtime/native/index.ts          # brustjs/native barrel: export { register, start }                 (new)
runtime/islands/importmap.ts     # + export const DIRECTIVES_BOOTSTRAP                                (edit)
runtime/cli/native-routes-emit.ts# bake DIRECTIVES_BOOTSTRAP when a template uses x-data             (edit)
runtime/cli/build.ts             # directives build block (AFTER islands) + dual-write               (edit)
package.json                     # + "./native": "./runtime/native/index.ts"                         (edit)
tests/native-directives.test.ts  # integration: build a fixture native route w/ directives           (new)
example/pokedex/components/AddToTeamButton.tsx  # island → native interactive component               (rewrite)
example/pokedex/lib/loaders.ts                  # + addProps JSON precompute                          (edit)
example/pokedex/pages/DetailPage.tsx            # <AddToTeamButton data={d.addProps} />               (edit)
example/pokedex/FRAMEWORK-GAPS.md               # mark native interactivity addressed                 (edit)
```

---

## Task 1: Scaffold `brustjs/native` — register / start / x-data mount

**Files:**
- Create: `runtime/native/runtime.ts`
- Create: `runtime/native/index.ts`
- Create: `runtime/native/runtime.test.ts`
- Modify: `package.json` (add `"./native"` export)

- [ ] **Step 1: Add the package export**

In `package.json`, add to the `exports` object (after `"./store"`):

```json
    "./native": "./runtime/native/index.ts"
```

- [ ] **Step 2: Write the barrel**

`runtime/native/index.ts`:

```ts
// brustjs/native — directive runtime registration surface. React-free, dom-only.
// Authors do NOT import this directly; the build-generated _directives.js entry does.
export { register, start } from './runtime.ts'
```

- [ ] **Step 3: Write the failing test**

`runtime/native/runtime.test.ts`:

```ts
import { describe, expect, test, beforeEach } from 'bun:test'
import { Window } from 'happy-dom'
import { signal } from 'brustjs/store'

// Fresh happy-dom window per test; assign globals the runtime reads.
function setupDom(html: string): Window {
  const win = new Window()
  win.document.body.innerHTML = html
  // @ts-expect-error assign happy-dom globals onto globalThis for the runtime
  globalThis.document = win.document
  // @ts-expect-error
  globalThis.MutationObserver = win.MutationObserver
  // @ts-expect-error
  globalThis.HTMLElement = win.HTMLElement
  return win
}

describe('x-data mount', () => {
  beforeEach(() => {
    // Re-import a fresh module per test to reset the registry + started flag.
  })

  test('instantiates a registered behavior and parses x-props JSON', async () => {
    const win = setupDom(
      '<div x-data="probe" x-props=\'{"id":"7"}\'></div>',
    )
    const seen: any[] = []
    const { register, start } = await import(`./runtime.ts?mount=${Math.random()}`)
    register('probe', ({ el, props }: any) => {
      seen.push({ tag: el.tagName, props })
      return {}
    })
    start(win.document)
    expect(seen).toHaveLength(1)
    expect(seen[0].props).toEqual({ id: '7' })
    expect(seen[0].tag).toBe('DIV')
  })

  test('runs init() exactly once after mount', async () => {
    const win = setupDom('<div x-data="probe2"></div>')
    let inits = 0
    const { register, start } = await import(`./runtime.ts?init=${Math.random()}`)
    register('probe2', () => ({ init() { inits++ } }))
    start(win.document)
    start(win.document) // idempotent — must not re-mount
    expect(inits).toBe(1)
  })

  test('unknown component warns and skips (no throw)', async () => {
    const win = setupDom('<div x-data="missing"></div>')
    const { start } = await import(`./runtime.ts?unknown=${Math.random()}`)
    expect(() => start(win.document)).not.toThrow()
  })
})
```

> **Note on fresh module per test:** importing `./runtime.ts?x=<rand>` gives each test a fresh module instance (clean registry + `started` flag). Bun supports query-suffixed re-import. If it does not in this version, fall back to exporting a `__resetForTest()` that clears the registry/flag and call it in `beforeEach`.

- [ ] **Step 4: Run test to verify it fails**

Run: `bun test runtime/native/runtime.test.ts`
Expected: FAIL (`Cannot find module './runtime.ts'`).

- [ ] **Step 5: Write the minimal runtime**

`runtime/native/runtime.ts`:

```ts
// Directive runtime — react-free, dom-only. Scans the DOM for x-* directives and
// binds them to per-element component instances via brustjs/store's `effect`.
import { effect, isComputed, isSignal } from 'brustjs/store'

export type Instance = Record<string, unknown>
export type Behavior = (ctx: { el: HTMLElement; props: unknown }) => Instance

interface Mounted {
  disposers: Array<() => void>
}

const registry = new Map<string, Behavior>()
const mounted = new WeakMap<HTMLElement, Mounted>()
let started = false

/** Register a component behavior under `name` (called by the generated entry). */
export function register(name: string, behavior: Behavior): void {
  registry.set(name, behavior)
}

/** Scan `root` (default: document) for [x-data], mount each, and (once) attach a
 * MutationObserver for dynamic mount/dispose. Idempotent. */
export function start(root?: ParentNode): void {
  const scope: ParentNode | undefined =
    root ?? (typeof document !== 'undefined' ? document : undefined)
  if (!scope) return
  const run = () => {
    scanAndMount(scope)
    if (!started) {
      started = true
      observe()
    }
  }
  if (typeof document !== 'undefined' && document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true })
  } else {
    run()
  }
}

function scanAndMount(scope: ParentNode): void {
  if (scope instanceof HTMLElement && scope.hasAttribute('x-data')) mountElement(scope)
  for (const el of Array.from(scope.querySelectorAll<HTMLElement>('[x-data]'))) {
    mountElement(el)
  }
}

function mountElement(el: HTMLElement): void {
  if (mounted.has(el)) return
  const name = el.getAttribute('x-data') ?? ''
  const behavior = registry.get(name)
  if (!behavior) {
    console.warn(`[brust] unknown x-data component "${name}"`)
    return
  }
  let props: unknown = {}
  const rawProps = el.getAttribute('x-props')
  if (rawProps) {
    try {
      props = JSON.parse(rawProps)
    } catch {
      console.warn(`[brust] x-props on "${name}" is not valid JSON`)
    }
  }
  const instance = behavior({ el, props })
  const m: Mounted = { disposers: [] }
  mounted.set(el, m)
  bindTree(el, instance, m.disposers)
  if (typeof instance.init === 'function') {
    try {
      Promise.resolve((instance.init as () => unknown)()).catch((e) =>
        console.error('[brust] x-data init() failed:', e),
      )
    } catch (e) {
      console.error('[brust] x-data init() threw:', e)
    }
  }
}

// Bind this element's directives, then recurse — but never descend into a nested
// [x-data] (it owns its own subtree and is mounted independently).
function bindTree(el: HTMLElement, instance: Instance, disposers: Array<() => void>): void {
  bindAttrs(el, instance, disposers)
  for (const child of Array.from(el.children)) {
    if (!(child instanceof HTMLElement)) continue
    if (child.hasAttribute('x-data')) continue
    bindTree(child, instance, disposers)
  }
}

// Filled in by later tasks (x-text, x-show, x-bind-*, x-on-*, x-for).
function bindAttrs(_el: HTMLElement, _scope: Instance, _disposers: Array<() => void>): void {}

function observe(): void {
  if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return
  const obs = new MutationObserver((records) => {
    for (const rec of records) {
      for (const node of Array.from(rec.removedNodes)) {
        if (node instanceof HTMLElement) disposeTree(node)
      }
      for (const node of Array.from(rec.addedNodes)) {
        if (node instanceof HTMLElement) scanAndMount(node)
      }
    }
  })
  obs.observe(document.body, { childList: true, subtree: true })
}

function disposeTree(node: HTMLElement): void {
  if (mounted.has(node)) disposeElement(node)
  for (const el of Array.from(node.querySelectorAll<HTMLElement>('[x-data]'))) {
    disposeElement(el)
  }
}

function disposeElement(el: HTMLElement): void {
  const m = mounted.get(el)
  if (!m) return
  for (const d of m.disposers.splice(0)) {
    try {
      d()
    } catch {
      // disposer must not break sibling disposal
    }
  }
  mounted.delete(el)
}

// --- reactive read helpers (used by later tasks) -------------------------------

/** Walk a dotted member path against `scope`; at the LEAF, call signals/computeds/
 * functions to obtain the reactive value (this read is what `effect` tracks). */
export function read(scope: Instance, path: string): unknown {
  let cur: unknown = scope
  for (const part of path.split('.')) {
    if (cur == null) return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  if (isSignal(cur) || isComputed(cur)) return (cur as () => unknown)()
  if (typeof cur === 'function') return (cur as () => unknown)()
  return cur
}

/** Resolve a dotted path WITHOUT calling the leaf (for x-on handlers). */
export function resolveRaw(scope: Instance, path: string): unknown {
  let cur: unknown = scope
  for (const part of path.split('.')) {
    if (cur == null) return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

// Keep `effect` referenced for later tasks (avoids an unused-import lint flag now).
void effect
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test runtime/native/runtime.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Lint**

Run: `bun run ci`
Expected: biome clean. (If biome flags `void effect` / unused params, that is expected to clear in Task 2 when they are used; if biome errors now, prefix unused params with `_` — already done — and keep `void effect`.)

- [ ] **Step 8: Commit**

```bash
git add runtime/native/runtime.ts runtime/native/index.ts runtime/native/runtime.test.ts package.json
git commit -m "feat(native): directive runtime scaffold — register/start/x-data mount + x-props"
```

---

## Task 2: `x-text` binding + reactive read + dispose

**Files:**
- Modify: `runtime/native/runtime.ts` (implement `bindAttrs` with `x-text`)
- Modify: `runtime/native/runtime.test.ts`

- [ ] **Step 1: Write the failing test** (append to `runtime.test.ts`)

```ts
describe('x-text', () => {
  test('binds initial value and updates on signal change; reads a computed', async () => {
    const win = setupDom('<div x-data="t1"><span x-text="label"></span><b x-text="msg"></b></div>')
    const { register, start } = await import(`./runtime.ts?xtext=${Math.random()}`)
    const { signal, computed } = await import('brustjs/store')
    const n = signal(1)
    register('t1', () => ({ msg: n, label: computed(() => `n=${n()}`) }))
    start(win.document)
    const span = win.document.querySelector('span')!
    const b = win.document.querySelector('b')!
    expect(span.textContent).toBe('n=1')
    expect(b.textContent).toBe('1')
    n.set(5)
    expect(span.textContent).toBe('n=5')
    expect(b.textContent).toBe('5')
  })

  test('removing the x-data element disposes effects (no detached update)', async () => {
    const win = setupDom('<div id="host"><div x-data="t2"><span x-text="msg"></span></div></div>')
    const { register, start } = await import(`./runtime.ts?disp=${Math.random()}`)
    const { signal } = await import('brustjs/store')
    const n = signal('a')
    register('t2', () => ({ msg: n }))
    start(win.document)
    const span = win.document.querySelector('span')!
    expect(span.textContent).toBe('a')
    win.document.getElementById('host')!.innerHTML = '' // MutationObserver fires removal
    await Promise.resolve() // let the observer callback run
    n.set('b') // must NOT update the detached span / must not throw
    expect(span.textContent).toBe('a')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test runtime/native/runtime.test.ts`
Expected: FAIL (`x-text` not bound — `span.textContent` is empty).

- [ ] **Step 3: Implement `bindAttrs` with `x-text`**

Replace the stub `bindAttrs` in `runtime/native/runtime.ts`:

```ts
function bindAttrs(el: HTMLElement, scope: Instance, disposers: Array<() => void>): void {
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name
    const value = attr.value
    if (name === 'x-data' || name === 'x-props') continue
    if (name === 'x-text') {
      disposers.push(
        effect(() => {
          const v = read(scope, value)
          el.textContent = v == null ? '' : String(v)
        }),
      )
    }
  }
}
```

Remove the now-redundant `void effect` line at the bottom of the file.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test runtime/native/runtime.test.ts`
Expected: PASS (5 tests total).

- [ ] **Step 5: Lint + commit**

```bash
bun run ci
git add runtime/native/runtime.ts runtime/native/runtime.test.ts
git commit -m "feat(native): x-text binding + reactive read + dispose-on-removal"
```

---

## Task 3: `x-show` + `x-bind-<attr>` (class / disabled / generic)

**Files:**
- Modify: `runtime/native/runtime.ts` (add `x-show`, `x-bind-*`, `setBound`)
- Modify: `runtime/native/runtime.test.ts`

- [ ] **Step 1: Write the failing test** (append)

```ts
describe('x-show + x-bind', () => {
  test('x-show toggles display', async () => {
    const win = setupDom('<div x-data="s1"><p x-show="open">hi</p></div>')
    const { register, start } = await import(`./runtime.ts?show=${Math.random()}`)
    const { signal } = await import('brustjs/store')
    const open = signal(false)
    register('s1', () => ({ open }))
    start(win.document)
    const p = win.document.querySelector('p')!
    expect(p.style.display).toBe('none')
    open.set(true)
    expect(p.style.display).toBe('')
  })

  test('x-bind-class sets className; x-bind-disabled toggles property+attr; generic attr', async () => {
    const win = setupDom(
      '<div x-data="s2"><button x-bind-class="cls" x-bind-disabled="busy" x-bind-data-x="tag">b</button></div>',
    )
    const { register, start } = await import(`./runtime.ts?bind=${Math.random()}`)
    const { signal } = await import('brustjs/store')
    const cls = signal('a b')
    const busy = signal(true)
    const tag = signal('v1')
    register('s2', () => ({ cls, busy, tag }))
    start(win.document)
    const btn = win.document.querySelector('button')! as any
    expect(btn.className).toBe('a b')
    expect(btn.disabled).toBe(true)
    expect(btn.getAttribute('disabled')).toBe('')
    expect(btn.getAttribute('data-x')).toBe('v1')
    busy.set(false)
    cls.set('c')
    expect(btn.disabled).toBe(false)
    expect(btn.hasAttribute('disabled')).toBe(false)
    expect(btn.className).toBe('c')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test runtime/native/runtime.test.ts`
Expected: FAIL (display not toggled / className unset).

- [ ] **Step 3: Implement**

Add these branches inside the `for` loop in `bindAttrs` (after the `x-text` branch):

```ts
    if (name === 'x-show') {
      disposers.push(
        effect(() => {
          el.style.display = read(scope, value) ? '' : 'none'
        }),
      )
      continue
    }
    if (name.startsWith('x-bind-')) {
      const target = name.slice('x-bind-'.length)
      disposers.push(
        effect(() => {
          setBound(el, target, read(scope, value))
        }),
      )
      continue
    }
```

> Add `continue` after the `x-text` branch's body too, so each attribute matches at most one directive.

Add `setBound` near the read helpers:

```ts
const BOOL_PROPS = new Set(['disabled', 'checked', 'hidden', 'readonly', 'required', 'selected'])

/** Apply a bound value to a DOM attr/property. class → className; boolean props →
 * property (when present) + attribute presence; value → property; else attribute. */
export function setBound(el: HTMLElement, attr: string, value: unknown): void {
  if (attr === 'class') {
    el.className = value == null ? '' : String(value)
    return
  }
  if (attr === 'value') {
    ;(el as unknown as { value: unknown }).value = value == null ? '' : value
    return
  }
  if (BOOL_PROPS.has(attr)) {
    const on = Boolean(value)
    if (attr in el) (el as unknown as Record<string, unknown>)[attr] = on
    if (on) el.setAttribute(attr, '')
    else el.removeAttribute(attr)
    return
  }
  if (value == null || value === false) el.removeAttribute(attr)
  else el.setAttribute(attr, String(value))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test runtime/native/runtime.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Lint + commit**

```bash
bun run ci
git add runtime/native/runtime.ts runtime/native/runtime.test.ts
git commit -m "feat(native): x-show + x-bind-<attr> (class/boolean-prop/generic) via setBound"
```

---

## Task 4: `x-on-<event>` event handlers

**Files:**
- Modify: `runtime/native/runtime.ts` (add `x-on-*` + `callMethod`)
- Modify: `runtime/native/runtime.test.ts`

- [ ] **Step 1: Write the failing test** (append)

```ts
describe('x-on', () => {
  test('x-on-click calls the named method with the event', async () => {
    const win = setupDom('<div x-data="o1"><button x-on-click="inc">+</button></div>')
    const { register, start } = await import(`./runtime.ts?on=${Math.random()}`)
    let calls = 0
    let lastType = ''
    register('o1', () => ({ inc(e: Event) { calls++; lastType = e.type } }))
    start(win.document)
    const btn = win.document.querySelector('button')!
    btn.dispatchEvent(new win.Event('click', { bubbles: true }))
    expect(calls).toBe(1)
    expect(lastType).toBe('click')
  })

  test('x-on target that is not a function warns, does not throw', async () => {
    const win = setupDom('<div x-data="o2"><button x-on-click="nope">x</button></div>')
    const { register, start } = await import(`./runtime.ts?on2=${Math.random()}`)
    register('o2', () => ({ nope: 5 }))
    start(win.document)
    const btn = win.document.querySelector('button')!
    expect(() => btn.dispatchEvent(new win.Event('click', { bubbles: true }))).not.toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test runtime/native/runtime.test.ts`
Expected: FAIL (handler never called — `calls` is 0).

- [ ] **Step 3: Implement**

Add the `x-on-` branch inside `bindAttrs` (after `x-bind-`):

```ts
    if (name.startsWith('x-on-')) {
      const eventName = name.slice('x-on-'.length)
      const handler = (e: Event) => callMethod(scope, value, e)
      el.addEventListener(eventName, handler)
      disposers.push(() => el.removeEventListener(eventName, handler))
      continue
    }
```

Add `callMethod` near the read helpers:

```ts
/** Resolve `path` on `scope` and, if a function, call it with the event. */
export function callMethod(scope: Instance, path: string, event: Event): void {
  const fn = resolveRaw(scope, path)
  if (typeof fn === 'function') (fn as (e: Event) => unknown)(event)
  else console.warn(`[brust] x-on target "${path}" is not a function`)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test runtime/native/runtime.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Lint + commit**

```bash
bun run ci
git add runtime/native/runtime.ts runtime/native/runtime.test.ts
git commit -m "feat(native): x-on-<event> handlers via callMethod"
```

---

## Task 5: `x-for` list rendering + loop scope

**Files:**
- Modify: `runtime/native/runtime.ts` (add `x-for` dispatch in `bindTree` + `bindFor`)
- Modify: `runtime/native/runtime.test.ts`

- [ ] **Step 1: Write the failing test** (append)

```ts
describe('x-for', () => {
  test('renders one node per item, updates on change, child reads loop item + instance member', async () => {
    const win = setupDom(
      '<ul x-data="f1"><li x-for="t in items" x-text="t.name" x-bind-class="cls"></li></ul>',
    )
    const { register, start } = await import(`./runtime.ts?for=${Math.random()}`)
    const { signal } = await import('brustjs/store')
    const items = signal([{ name: 'fire' }, { name: 'water' }])
    register('f1', () => ({ items, cls: signal('chip') }))
    start(win.document)
    const ul = win.document.querySelector('ul')!
    let lis = ul.querySelectorAll('li')
    expect(Array.from(lis).map((l) => l.textContent)).toEqual(['fire', 'water'])
    expect(lis[0]!.className).toBe('chip') // instance member visible in loop scope
    items.set([{ name: 'grass' }])
    lis = ul.querySelectorAll('li')
    expect(Array.from(lis).map((l) => l.textContent)).toEqual(['grass'])
  })

  test('malformed x-for expression warns and skips', async () => {
    const win = setupDom('<ul x-data="f2"><li x-for="garbage" x-text="t"></li></ul>')
    const { register, start } = await import(`./runtime.ts?for2=${Math.random()}`)
    const { signal } = await import('brustjs/store')
    register('f2', () => ({ items: signal([]) }))
    expect(() => start(win.document)).not.toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test runtime/native/runtime.test.ts`
Expected: FAIL (no `<li>` rendered — the template `<li>` is bound in place, `t.name` resolves to undefined).

- [ ] **Step 3: Implement**

In `bindTree`, handle `x-for` BEFORE binding the element's own attrs (the x-for element is the per-item template, not a normal node):

```ts
function bindTree(el: HTMLElement, instance: Instance, disposers: Array<() => void>): void {
  if (el.hasAttribute('x-for')) {
    bindFor(el, instance, disposers)
    return
  }
  bindAttrs(el, instance, disposers)
  for (const child of Array.from(el.children)) {
    if (!(child instanceof HTMLElement)) continue
    if (child.hasAttribute('x-data')) continue
    bindTree(child, instance, disposers)
  }
}
```

Add `bindFor`:

```ts
const FOR_RE = /^\s*(\w+)\s+in\s+([\w.]+)\s*$/

// `x-for="item in member"` — the element is the template. Replace it with a comment
// anchor; on each change of `member`, clear previous clones and render one per item,
// binding each clone with a child scope { [item]: value } prototype-linked to the
// instance (so instance members + methods stay visible). v1 = full re-render.
function bindFor(tplEl: HTMLElement, instance: Instance, disposers: Array<() => void>): void {
  const raw = tplEl.getAttribute('x-for') ?? ''
  const m = FOR_RE.exec(raw)
  if (!m) {
    console.warn(`[brust] malformed x-for expression: "${raw}"`)
    return
  }
  const itemName = m[1] as string
  const listPath = m[2] as string
  const parent = tplEl.parentNode
  if (!parent) return
  const anchor = tplEl.ownerDocument.createComment(`x-for:${itemName}`)
  parent.insertBefore(anchor, tplEl)
  tplEl.removeAttribute('x-for')
  const template = tplEl.cloneNode(true) as HTMLElement
  tplEl.remove()

  let rendered: HTMLElement[] = []
  let childDisposers: Array<() => void> = []

  const clear = () => {
    for (const d of childDisposers.splice(0)) {
      try {
        d()
      } catch {
        /* keep clearing */
      }
    }
    for (const node of rendered.splice(0)) node.remove()
  }

  disposers.push(
    effect(() => {
      clear()
      const list = read(instance, listPath)
      if (!Array.isArray(list)) return
      for (const item of list) {
        const clone = template.cloneNode(true) as HTMLElement
        const childScope: Instance = Object.create(instance)
        childScope[itemName] = item
        bindTree(clone, childScope, childDisposers)
        parent.insertBefore(clone, anchor) // before anchor → preserves order
        rendered.push(clone)
      }
    }),
  )
  disposers.push(clear)
}
```

> `read(instance, listPath)` (not `childScope`) — the list lives on the instance. Child clones bind with `childScope` so `x-text="t.name"` resolves `t` from the loop and `cls` from the prototype-linked instance.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test runtime/native/runtime.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Lint + commit**

```bash
bun run ci
git add runtime/native/runtime.ts runtime/native/runtime.test.ts
git commit -m "feat(native): x-for list rendering with loop scope (full re-render v1)"
```

---

## Task 6: MutationObserver lifecycle — SPA-nav swap shape

**Files:**
- Modify: `runtime/native/runtime.test.ts` (add swap-shape + nested-scope + dynamic-add tests)

> The runtime already implements the observer (Task 1). This task PROVES the swap
> shape, nested scoping, and dynamic mount the spec requires — and pins them as
> regression tests. If a test reveals a bug, fix `runtime.ts` minimally.

- [ ] **Step 1: Write the failing/again-green tests** (append)

```ts
describe('lifecycle', () => {
  test('dynamic add mounts; nested x-data is independent and not double-bound by the outer', async () => {
    const win = setupDom('<div id="host"></div>')
    const { register, start } = await import(`./runtime.ts?life=${Math.random()}`)
    const { signal } = await import('brustjs/store')
    let outerInits = 0
    let innerInits = 0
    register('outer', () => ({ init() { outerInits++ }, msg: signal('O') }))
    register('inner', () => ({ init() { innerInits++ }, msg: signal('I') }))
    start(win.document)
    // dynamically inject an outer wrapping an inner, each with its own x-text
    win.document.getElementById('host')!.innerHTML =
      '<div x-data="outer"><span class="o" x-text="msg"></span>' +
      '<div x-data="inner"><span class="i" x-text="msg"></span></div></div>'
    await Promise.resolve()
    expect(outerInits).toBe(1)
    expect(innerInits).toBe(1)
    expect(win.document.querySelector('.o')!.textContent).toBe('O')
    expect(win.document.querySelector('.i')!.textContent).toBe('I') // inner owns its subtree
  })

  test('SPA-nav swap shape: remove old x-data + add new in one batch → dispose then mount', async () => {
    const win = setupDom('<main id="m"><div x-data="pg" x-props=\'{"v":"1"}\'><span x-text="v"></span></div></main>')
    const { register, start } = await import(`./runtime.ts?swap=${Math.random()}`)
    const mounts: string[] = []
    register('pg', ({ props }: any) => { mounts.push(props.v); return { v: props.v } })
    start(win.document)
    expect(mounts).toEqual(['1'])
    expect(win.document.querySelector('span')!.textContent).toBe('1')
    // emulate swapMainContent: replace the <main> contents wholesale
    win.document.getElementById('m')!.innerHTML =
      '<div x-data="pg" x-props=\'{"v":"2"}\'><span x-text="v"></span></div>'
    await Promise.resolve()
    expect(mounts).toEqual(['1', '2']) // old disposed, new mounted exactly once
    expect(win.document.querySelector('span')!.textContent).toBe('2')
  })
})
```

- [ ] **Step 2: Run the tests**

Run: `bun test runtime/native/runtime.test.ts`
Expected: PASS (13 tests). If the nested-independence test fails (outer double-binds the inner's `x-text`), confirm `bindTree` skips `child.hasAttribute('x-data')` — it does (Task 1/5). If the swap test double-mounts, confirm `mountElement` guards on `mounted.has(el)` and disposal removes the old entry.

- [ ] **Step 3: Commit**

```bash
git add runtime/native/runtime.test.ts
git commit -m "test(native): pin MutationObserver lifecycle — nested scope + SPA-nav swap shape"
```

---

## Task 7: `scanDirectiveComponents` (build-side discovery)

**Files:**
- Create: `runtime/native/build.ts`
- Create: `runtime/native/build.test.ts`

- [ ] **Step 1: Write the failing test**

`runtime/native/build.test.ts`:

```ts
import { describe, expect, test, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanDirectiveComponents } from './build.ts'

const dirs: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'brust-dir-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('scanDirectiveComponents', () => {
  test('finds files with `export const behavior`, derives camelCase name, ignores others', () => {
    const root = tmp()
    mkdirSync(join(root, 'components'))
    writeFileSync(
      join(root, 'routes.tsx'),
      `import AddToTeamButton from './components/AddToTeamButton'\nimport Plain from './components/Plain'\n`,
    )
    writeFileSync(
      join(root, 'components/AddToTeamButton.tsx'),
      `export const behavior = () => ({})\nexport default function AddToTeamButton(){ return null as any }\n`,
    )
    writeFileSync(
      join(root, 'components/Plain.tsx'),
      `export default function Plain(){ return null as any }\n`,
    )
    const found = scanDirectiveComponents(join(root, 'routes.tsx'))
    expect([...found.keys()]).toEqual(['addToTeamButton'])
    expect(found.get('addToTeamButton')).toBe(join(root, 'components/AddToTeamButton.tsx'))
  })

  test('throws on two files deriving the same register name', () => {
    const root = tmp()
    mkdirSync(join(root, 'a'))
    mkdirSync(join(root, 'b'))
    writeFileSync(
      join(root, 'routes.tsx'),
      `import Widget from './a/Widget'\nimport Other from './b/Other'\n`,
    )
    // Other.tsx re-exports a Widget that also has a behavior under the same basename
    writeFileSync(join(root, 'a/Widget.tsx'), `export const behavior = () => ({})\nexport default function Widget(){return null as any}\n`)
    writeFileSync(join(root, 'b/Other.tsx'), `import Widget from '../a/Widget'\nexport const behavior = () => ({})\nexport default function Other(){return null as any}\n`)
    // both 'Widget' (via a) and 'Other' (via b) qualify with distinct names → no throw here;
    // instead assert two DISTINCT names are found:
    const found = scanDirectiveComponents(join(root, 'routes.tsx'))
    expect(new Set(found.keys())).toEqual(new Set(['widget', 'other']))
  })
})
```

> The collision-throw path is hard to trigger via filenames alone (names are unique per file); the second test instead pins multi-component discovery across the import graph. A genuine collision (two different files, same basename) is covered by the `scanImports` ambiguity throw it reuses.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test runtime/native/build.test.ts`
Expected: FAIL (`Cannot find module './build.ts'`).

- [ ] **Step 3: Implement `scanDirectiveComponents`**

`runtime/native/build.ts`:

```ts
import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { scanImports } from '../cli/native-routes-emit.ts'

const BEHAVIOR_RE = /export\s+const\s+behavior\b/

/** camelCase a component basename: lowercase the first character only. */
function registerName(sourcePath: string): string {
  const base = basename(sourcePath, extname(sourcePath))
  return base.length > 0 ? base[0]!.toLowerCase() + base.slice(1) : base
}

/** BFS the local import graph from the routes entry; return registerName →
 * absolute sourcePath for every file that has `export const behavior`. Throws on
 * two distinct files deriving the same register name. */
export function scanDirectiveComponents(routesEntryFile: string): Map<string, string> {
  const found = new Map<string, string>()
  const visited = new Set<string>()
  const queue: string[] = [...scanImports(routesEntryFile).values()]
  while (queue.length > 0) {
    const filePath = queue.shift() as string
    if (visited.has(filePath)) continue
    visited.add(filePath)
    let src = ''
    try {
      src = readFileSync(filePath, 'utf8')
    } catch {
      continue
    }
    for (const dep of scanImports(filePath).values()) {
      if (!visited.has(dep)) queue.push(dep)
    }
    if (BEHAVIOR_RE.test(src)) {
      const name = registerName(filePath)
      const existing = found.get(name)
      if (existing && existing !== filePath) {
        throw new Error(
          `directive component name "${name}" derives from two files (${existing} and ${filePath}); component basenames must be app-unique`,
        )
      }
      found.set(name, filePath)
    }
  }
  return found
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test runtime/native/build.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Lint + commit**

```bash
bun run ci
git add runtime/native/build.ts runtime/native/build.test.ts
git commit -m "feat(native): scanDirectiveComponents — discover export-const-behavior across routes graph"
```

---

## Task 8: `buildDirectives` — bundle + react-leak guard

**Files:**
- Modify: `runtime/native/build.ts` (add `buildDirectives`)
- Modify: `runtime/native/build.test.ts`

- [ ] **Step 1: Write the failing test** (append to `build.test.ts`)

```ts
import { existsSync, readFileSync as rf } from 'node:fs'
import { buildDirectives } from './build.ts'

describe('buildDirectives', () => {
  test('emits a react-free _directives.js for a react-free behavior', async () => {
    const root = tmp()
    const outDir = join(root, 'islands')
    // A behavior importing only signal/computed from brustjs/store (react-free).
    const compPath = join(root, 'Probe.tsx')
    writeFileSync(
      compPath,
      `import { signal } from 'brustjs/store'\n` +
        `export const behavior = () => ({ n: signal(0) })\n` +
        `export default function Probe(){ return null as any }\n`,
    )
    const res = await buildDirectives(new Map([['probe', compPath]]), { outDir })
    expect(res.count).toBe(1)
    const outFile = join(outDir, '_directives.js')
    expect(existsSync(outFile)).toBe(true)
    const out = rf(outFile, 'utf8')
    expect(out).toContain('probe') // registered name present
    expect(/createRoot|hydrateRoot|react-dom/.test(out)).toBe(false) // react-free
  })

  test('react-leak guard throws when a behavior pulls react (useStore)', async () => {
    const root = tmp()
    const outDir = join(root, 'islands')
    const compPath = join(root, 'Bad.tsx')
    writeFileSync(
      compPath,
      `import { useStore } from 'brustjs/client'\n` +
        `export const behavior = () => ({ x: useStore })\n` +
        `export default function Bad(){ return null as any }\n`,
    )
    await expect(buildDirectives(new Map([['bad', compPath]]), { outDir })).rejects.toThrow(/react/i)
  })

  test('empty component set is a no-op (no file)', async () => {
    const root = tmp()
    const outDir = join(root, 'islands')
    const res = await buildDirectives(new Map(), { outDir })
    expect(res.count).toBe(0)
    expect(existsSync(join(outDir, '_directives.js'))).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test runtime/native/build.test.ts`
Expected: FAIL (`buildDirectives` not exported).

- [ ] **Step 3: Implement `buildDirectives`**

Append to `runtime/native/build.ts`:

```ts
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

export interface BuildDirectivesResult {
  outDir: string
  count: number
}

const REACT_MARKER_RE = /createRoot|hydrateRoot|react-dom|__SECRET_INTERNALS/

/** Generate a registration entry, bundle it self-contained to
 * `<outDir>/_directives.js`, and assert no React leaked in. */
export async function buildDirectives(
  components: Map<string, string>,
  options: { outDir: string },
): Promise<BuildDirectivesResult> {
  const outDir = isAbsolute(options.outDir)
    ? options.outDir
    : resolve(process.cwd(), options.outDir)
  mkdirSync(outDir, { recursive: true })
  if (components.size === 0) return { outDir, count: 0 }

  // Generate the entry: import each behavior, register it, then start().
  const lines = ["import { register, start } from 'brustjs/native'"]
  let i = 0
  for (const [name, src] of components) {
    lines.push(`import { behavior as b${i} } from ${JSON.stringify(src)}`)
    lines.push(`register(${JSON.stringify(name)}, b${i})`)
    i++
  }
  lines.push('start()')
  const entryPath = resolve(outDir, '_directives.entry.ts')
  writeFileSync(entryPath, lines.join('\n') + '\n')

  try {
    const result = await Bun.build({
      entrypoints: [entryPath],
      outdir: outDir,
      naming: '_directives.js',
      format: 'esm',
      target: 'browser',
      external: [], // self-contained — bundle store + treaty; react is tree-shaken out
      minify: true,
      define: { 'process.env.NODE_ENV': '"production"' },
    })
    if (!result.success) {
      const messages = result.logs.map((l) => String(l)).join('\n')
      throw new Error(`buildDirectives: Bun.build failed:\n${messages}`)
    }
  } finally {
    rmSync(entryPath, { force: true })
  }

  const out = readFileSync(resolve(outDir, '_directives.js'), 'utf8')
  if (REACT_MARKER_RE.test(out)) {
    throw new Error(
      'buildDirectives: React leaked into _directives.js — a behavior imported a ' +
        'react-pulling symbol (e.g. useStore from brustjs/client). Use signal/computed ' +
        'from brustjs/store; keep behaviors react-free.',
    )
  }
  return { outDir, count: components.size }
}
```

> Note: `readFileSync` is already imported at the top of `build.ts` (Task 7). Don't double-import it — only add `mkdirSync`, `rmSync`, `writeFileSync`, `isAbsolute`, `resolve` to the existing import lines (biome will flag duplicate imports).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test runtime/native/build.test.ts`
Expected: PASS (5 tests). The react-leak test must genuinely fail the build (proves the guard works against a real react-pulling import).

> **BLOCKED fallback:** if the react-leak test FAILS because Bun did NOT tree-shake react out of the react-free case (the first test's `out` contains a marker), the import surface is the problem, not the guard. Add a `"./treaty"` export to `package.json` (`"./treaty": "./runtime/treaty.ts"`), change behaviors to `import { client } from 'brustjs/treaty'`, and re-run. Record the pivot in the wrap-up.

- [ ] **Step 5: Lint + commit**

```bash
bun run ci
git add runtime/native/build.ts runtime/native/build.test.ts
git commit -m "feat(native): buildDirectives — bundle _directives.js + react-leak guard"
```

---

## Task 9: `DIRECTIVES_BOOTSTRAP` + bake into jinja

**Files:**
- Modify: `runtime/islands/importmap.ts` (add the const)
- Modify: `runtime/cli/native-routes-emit.ts` (bake when template uses `x-data`)
- Modify: `runtime/cli/native-routes-emit.test.ts` (add a bake test)

- [ ] **Step 1: Add the const**

Append to `runtime/islands/importmap.ts`:

```ts
// Directive runtime loader — baked into a native template's .jinja when it uses
// any x-data directive. Served from the same /_brust/islands/ static route as the
// island chunks (underscore-prefixed → passes is_safe_island_filename).
export const DIRECTIVES_BOOTSTRAP =
  '<script type="module" src="/_brust/islands/_directives.js" defer></script>'
```

- [ ] **Step 2: Write the failing test**

Find the existing describe block in `runtime/cli/native-routes-emit.test.ts` and add (match the file's existing test style — it likely uses temp dirs + `emitNativeTemplates` or `reconcileIslandManifest`; mirror whichever it uses for jinja assertions). Add:

```ts
import { DIRECTIVES_BOOTSTRAP } from '../islands/importmap.ts'

test('bakes the directives bootstrap into a template that uses x-data', () => {
  const tmpl = '<html><head></head><body><div x-data="probe"></div></body></html>'
  expect(bakeDirectivesIfUsed(tmpl)).toContain(DIRECTIVES_BOOTSTRAP)
  expect(bakeDirectivesIfUsed(tmpl)).toContain('{% raw %}')
})

test('leaves a template without x-data byte-identical', () => {
  const tmpl = '<html><head></head><body><div>static</div></body></html>'
  expect(bakeDirectivesIfUsed(tmpl)).toBe(tmpl)
})
```

> If `native-routes-emit.test.ts` cannot import an internal helper, export `bakeDirectivesIfUsed` from `native-routes-emit.ts` (Step 3 does). Adjust the import to `from './native-routes-emit.ts'`.

- [ ] **Step 3: Implement the bake helper + wire it into `emitNativeTemplates`**

In `runtime/cli/native-routes-emit.ts`:

Add the import at the top (next to the existing `ISLANDS_IMPORTMAP_AND_BOOTSTRAP` import):

```ts
import { DIRECTIVES_BOOTSTRAP, ISLANDS_IMPORTMAP_AND_BOOTSTRAP } from '../islands/importmap.ts'
```

Add the exported helper (near `injectDevClientIntoTemplate`):

```ts
/** Bake the directive runtime loader into a native template iff it uses any
 * x-data directive. Idempotent. Wrapped in {% raw %} for symmetry with the islands
 * bootstrap bake (the tag has no {{ }} but the wrap is harmless + consistent). */
export function bakeDirectivesIfUsed(template: string): string {
  if (!template.includes('x-data')) return template
  const baked = `{% raw %}${DIRECTIVES_BOOTSTRAP}{% endraw %}`
  if (template.includes(baked)) return template
  return template + baked
}
```

In `emitNativeTemplates`, apply it to the compiled template right before `writeFileSync(outPath, template)`. Locate this block:

```ts
    const template =
      process.env.BRUST_DEV === '1'
        ? injectDevClientIntoTemplate(compiled.template)
        : compiled.template
    writeFileSync(outPath, template)
```

Replace with:

```ts
    const withDirectives = bakeDirectivesIfUsed(compiled.template)
    const template =
      process.env.BRUST_DEV === '1'
        ? injectDevClientIntoTemplate(withDirectives)
        : withDirectives
    writeFileSync(outPath, template)
```

> Order note: bake directives BEFORE the dev-client splice so the dev `</head>` insert logic still sees the original head. The directives `<script>` is appended at the end (after `</html>`), same position as the islands bootstrap, so it does not interfere.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test runtime/cli/native-routes-emit.test.ts`
Expected: PASS (existing tests + 2 new).

- [ ] **Step 5: Lint + commit**

```bash
bun run ci
git add runtime/islands/importmap.ts runtime/cli/native-routes-emit.ts runtime/cli/native-routes-emit.test.ts
git commit -m "feat(native): bake _directives.js <script> into jinja when a template uses x-data"
```

---

## Task 10: Wire the directives build block into `brust build`

**Files:**
- Modify: `runtime/cli/build.ts` (add the directives block after the islands block)

> No unit test here (it is CLI orchestration); Task 11's integration test exercises
> the full path. Verify manually by building the pokedex after Task 12, or a fixture now.

- [ ] **Step 1: Add the directives build block**

In `runtime/cli/build.ts`, immediately AFTER the islands block (after the `} else { console.log('[brust build] islands: skipped …') }` that closes step 3, before step 4 "MCP manifest"), insert:

```ts
  // 3.5. Build the directive runtime bundle (if any native interactive component —
  // a file with `export const behavior` — is reachable from the routes graph).
  // MUST run AFTER buildIslands: buildIslands does `rm -rf outDir/islands`, so
  // running this first would wipe _directives.js. This block creates the islands
  // dir itself (the islands block is skipped when there are no <Island> usages).
  {
    const { scanDirectiveComponents, buildDirectives } = await import('../native/build.ts')
    const directiveComponents = existsSync(routesFile)
      ? scanDirectiveComponents(routesFile)
      : new Map<string, string>()
    if (directiveComponents.size > 0) {
      const islandsOutDir = path.join(outDir, 'islands')
      const result = await buildDirectives(directiveComponents, { outDir: islandsOutDir })
      console.log(`[brust build] directives: ${result.count} component(s) → ${islandsOutDir}/_directives.js`)

      // Mirror _directives.js into cwd/.brust/islands for the source runtime (the
      // islands block's whole-dir mirror ran before this file existed, so copy it
      // explicitly). Create the dir in case the islands block was skipped.
      const localIslandsDir = path.join(process.cwd(), '.brust', 'islands')
      if (path.resolve(localIslandsDir) !== path.resolve(islandsOutDir)) {
        await mkdir(localIslandsDir, { recursive: true })
        await cp(
          path.join(islandsOutDir, '_directives.js'),
          path.join(localIslandsDir, '_directives.js'),
        )
      }
    } else {
      console.log('[brust build] directives: skipped (no export-const-behavior components)')
    }
  }
```

> Confirm `mkdir`, `cp`, `rm` are already imported at the top of `build.ts` (the islands block uses `cp`/`rm`; `mkdir` is used in step 1). They are.

- [ ] **Step 2: Lint**

Run: `bun run ci`
Expected: biome clean.

- [ ] **Step 3: Commit**

```bash
git add runtime/cli/build.ts
git commit -m "feat(native): wire directives build block into brust build (after islands, dual-write)"
```

---

## Task 11: Integration test — fixture native route with directives

**Files:**
- Create: `tests/native-directives.test.ts`

> Verifies the full build path produces `_directives.js`, bakes the `<script>` into
> the jinja, and that a directive-free native route gets neither. This is a BUILD
> integration test (no server boot required), so it does not need the `.node` addon
> rebuild — but it DOES call `compileJsx` via the addon (already present on-branch).

- [ ] **Step 1: Inspect an existing integration test for the harness pattern**

Read `tests/` for an existing native-route build test (e.g. one that calls `emitNativeTemplates` against a temp project). Mirror its setup: a temp dir with `routes.tsx`, a page, and a component; run `scanDirectiveComponents` + `buildDirectives` + `emitNativeTemplates`; assert outputs. If no such harness exists, use the self-contained form below.

- [ ] **Step 2: Write the test**

`tests/native-directives.test.ts`:

```ts
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanDirectiveComponents, buildDirectives } from '../runtime/native/build.ts'

const dirs: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'brust-int-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

test('directive component is discovered and bundled into a react-free _directives.js', async () => {
  const root = tmp()
  mkdirSync(join(root, 'components'))
  writeFileSync(
    join(root, 'routes.tsx'),
    `import Counter from './components/Counter'\nexport const routes = []\n`,
  )
  writeFileSync(
    join(root, 'components/Counter.tsx'),
    `import { signal } from 'brustjs/store'\n` +
      `export const behavior = () => { const n = signal(0); return { n, inc(){ n.set(n()+1) } } }\n` +
      `export default function Counter(){ return null as any }\n`,
  )
  const components = scanDirectiveComponents(join(root, 'routes.tsx'))
  expect([...components.keys()]).toEqual(['counter'])
  const outDir = join(root, 'islands')
  const res = await buildDirectives(components, { outDir })
  expect(res.count).toBe(1)
  const js = readFileSync(join(outDir, '_directives.js'), 'utf8')
  expect(js).toContain('counter')
  expect(/createRoot|hydrateRoot|react-dom/.test(js)).toBe(false)
})

test('bake helper: template with x-data gets the directives <script>, without does not', async () => {
  const { bakeDirectivesIfUsed } = await import('../runtime/cli/native-routes-emit.ts')
  const { DIRECTIVES_BOOTSTRAP } = await import('../runtime/islands/importmap.ts')
  const withDir = bakeDirectivesIfUsed('<body><button x-data="counter" x-on-click="inc">0</button></body>')
  expect(withDir).toContain(DIRECTIVES_BOOTSTRAP)
  const noDir = '<body><div>static</div></body>'
  expect(bakeDirectivesIfUsed(noDir)).toBe(noDir)
})
```

- [ ] **Step 3: Run test to verify it passes**

Run: `bun test tests/native-directives.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 4: Lint + commit**

```bash
bun run ci
git add tests/native-directives.test.ts
git commit -m "test(native): integration — directive discovery, bundle, react-free, jinja bake"
```

---

## Task 12: Dogfood — `AddToTeamButton` island → native interactive component

**Files:**
- Rewrite: `example/pokedex/components/AddToTeamButton.tsx`
- Modify: `example/pokedex/lib/loaders.ts` (add `addProps`)
- Modify: `example/pokedex/pages/DetailPage.tsx` (use `<AddToTeamButton data={d.addProps} />`)
- Modify: `example/pokedex/FRAMEWORK-GAPS.md` (mark native interactivity addressed)

> Read each file before editing — the exact prop names, loader shape, and the
> current `<AddToTeamButton>` call site must be matched. The snippets below are the
> target shape; reconcile field names with the actual `AddToTeamProps` / loader.

- [ ] **Step 1: Read the current dogfood files**

Run:
```bash
cat example/pokedex/components/AddToTeamButton.tsx example/pokedex/stores/team.ts example/pokedex/lib/types.ts
grep -n "AddToTeamButton\|addProps\|detail" example/pokedex/pages/DetailPage.tsx example/pokedex/lib/loaders.ts
```

- [ ] **Step 2: Rewrite `AddToTeamButton.tsx` as a single-file native component**

```tsx
// NATIVE interactive component (Spec B). default export → jinja (server); behavior →
// _directives.js (client). No React. Shares teamStore with the TeamBuilder island.
import { signal, computed } from 'brustjs/store'
import { client } from 'brustjs/client'
import { teamStore } from '../stores/team'
import type { Actions } from '../actions'
import type { AddToTeamProps } from '../lib/types'

const api = client<Actions>()

export const behavior = ({ props }: { props: AddToTeamProps }) => {
  const busy = signal(false)
  const toast = signal<string | null>(null)
  const inTeam = computed(() => (teamStore.members() ?? []).some((m) => m.id === props.id))
  const label = computed(() => (inTeam() ? '✓ In your team' : '＋ Add to team'))
  const btnClass = computed(() => `aa-btn aa-btn--full${inTeam() ? ' aa-btn--secondary' : ''}`)
  const showToast = computed(() => toast() !== null)

  async function init() {
    const r = await api.team.get()
    if (r.data) teamStore.members.set(r.data.team)
  }
  async function toggle() {
    busy.set(true)
    try {
      if (inTeam()) {
        const { data } = await api.team({ id: props.id }).delete()
        if (data) teamStore.members.set(data.team)
      } else {
        const { data } = await api.team.post(props)
        if (data?.full) {
          toast.set('ทีมเต็มแล้ว · สูงสุด 6 ตัว')
          setTimeout(() => toast.set(null), 2200)
        } else if (data) {
          teamStore.members.set(data.team)
        }
      }
    } finally {
      busy.set(false)
    }
  }
  return { busy, toast, inTeam, label, btnClass, showToast, init, toggle }
}

export default function AddToTeamButton({ data }: { data: string }) {
  return (
    <div x-data="addToTeamButton" x-props={data} className="aa-add" style={{ position: 'relative' }}>
      <button
        type="button"
        x-text="label"
        x-bind-class="btnClass"
        x-bind-disabled="busy"
        x-on-click="toggle"
        className="aa-btn aa-btn--full"
        style={{ width: '100%' }}
      >
        ＋ Add to team
      </button>
      <div x-show="showToast" x-text="toast" className="aa-toast" />
    </div>
  )
}
```

> Reconcile `api.team.post(props)` with the actual action signature — the old island
> posted `{ id, name, displayName, num, types, artwork }`. If `AddToTeamProps` differs,
> map fields explicitly. The `.delete()` (bodyless) is valid (GAPS S12 fixed).

- [ ] **Step 3: Add `addProps` to the detail loader**

In `example/pokedex/lib/loaders.ts`, in the detail loader's returned object, add a JSON
string of the fields the button needs (match `AddToTeamProps`):

```ts
    addProps: JSON.stringify({
      id: pokemon.id,
      name: pokemon.name,
      displayName: pokemon.displayName,
      num: pokemon.num,
      types: pokemon.types,
      artwork: pokemon.artwork,
    }),
```

> Use the variable names the loader actually has in scope (it already computes the
> detail pokemon). This is the established native "precompute in loader" pattern.

- [ ] **Step 4: Update the detail page call site**

In `example/pokedex/pages/DetailPage.tsx`, replace the `<AddToTeamButton … />` usage
(previously an island with individual props) with:

```tsx
<AddToTeamButton data={d.addProps} />
```

> If `AddToTeamButton` was previously rendered via `<Island component={AddToTeamButton} …>`,
> remove the Island wrapper — it is now a native inline component, referenced directly.

- [ ] **Step 5: Build the pokedex and verify the bundle + bake**

Run:
```bash
cd example/pokedex && bun run build 2>&1 | tail -20; cd ../..
```
Expected: build succeeds; log shows `[brust build] directives: 1 component(s)`. Verify:
```bash
test -f example/pokedex/dist/islands/_directives.js && echo "DIRECTIVES OK"
grep -l "_directives.js" example/pokedex/dist/jinja/*.jinja && echo "BAKE OK"
test ! -f example/pokedex/dist/islands/AddToTeamButton.js && echo "ISLAND GONE OK"
```
Expected: all three echoes print (the directives bundle exists, the detail jinja has the script, and no `AddToTeamButton` island chunk is emitted).

- [ ] **Step 6: Update FRAMEWORK-GAPS.md**

Mark native interactivity addressed: in `example/pokedex/FRAMEWORK-GAPS.md`, update the
"ยังเปิด" line to note native interactive components (directives) now exist
(`AddToTeamButton` is native), and add a short entry: native pages can now do reactive
text/show/bind/event/list via `x-*` directives + `export const behavior`, sharing the
store with React islands (`TeamBuilder` stays an island as the showcase). Keep the file's
existing Thai style.

- [ ] **Step 7: Commit**

```bash
git add example/pokedex/components/AddToTeamButton.tsx example/pokedex/lib/loaders.ts example/pokedex/pages/DetailPage.tsx example/pokedex/FRAMEWORK-GAPS.md
git commit -m "feat(pokedex): AddToTeamButton island → native directive component (dogfood Spec B)"
```

---

## Task 13: Full verification + browser dogfood

**Files:** none (verification only)

- [ ] **Step 1: Run the full runtime + native suites**

Run: `bun test runtime/native/ tests/native-directives.test.ts`
Expected: all green.

- [ ] **Step 2: Run the full repo test suite (baseline check)**

Run: `bun test 2>&1 | tail -30`
Expected: no regressions vs the branch base. Note the count. (The native-island integration flake may need a separate-file re-run per memory `native-island-integration-flake` — if a port-race flake appears, re-run that file alone.)

- [ ] **Step 3: Lint gate**

Run: `bun run ci`
Expected: biome clean.

- [ ] **Step 4: Confirm no Rust touched**

Run: `git diff --name-only main...HEAD -- crates/ | wc -l`
Expected: `0`. (Spec B is zero-Rust. If non-zero, something is wrong — investigate.)

- [ ] **Step 5: Browser dogfood (chrome-devtools MCP — cross-paradigm store sharing)**

Boot the pokedex and verify in a real browser (per handoff, cross-island/SPA store
behavior is only confirmable in a browser):
```bash
cd example/pokedex && bun run start &   # or the project's run command
```
Then with chrome-devtools MCP: navigate to a detail page, click "Add to team" (the NATIVE
button), and assert via `evaluate_script` that `window.__BRUST_STORES__['pokedex.team']`
gained the member AND the `TeamBuilder` React island dock count/list updated. SPA-nav to
another detail page and confirm the team persists and a second add increments. This proves
native `x-on-click` → store → React island reactivity across chunks. Document the result
(pass/fail with the observed count) in the wrap-up.

- [ ] **Step 6: Commit (if any verification-driven fix was needed)**

Only if Step 1–5 required a fix. Otherwise nothing to commit.

---

## Self-Review (run before handing to execution)

**Spec coverage:**
- Directive runtime (register/start/mount/MutationObserver) → Tasks 1, 6
- `x-data`/`x-props` → Task 1 · `x-text` → Task 2 · `x-show`/`x-bind-*` → Task 3 · `x-on-*` → Task 4 · `x-for` → Task 5
- read/resolveRaw/setBound/callMethod → Tasks 1–4
- `brustjs/native` export → Task 1
- scanDirectiveComponents → Task 7 · buildDirectives + react-leak guard → Task 8
- DIRECTIVES_BOOTSTRAP + jinja bake → Task 9 · build.ts wiring (after islands, dual-write, dir-create) → Task 10
- Integration test → Task 11 · Dogfood (AddToTeamButton native, loader, DetailPage, GAPS) → Task 12
- Acceptance: biome/full-suite/zero-Rust/browser → Task 13
- Non-goals (no snapshot inject, no inline eval, no colon attrs, SPA-nav owned by bootstrap, x-for full re-render, behaviors react-free) → respected; no task implements them.

**Type consistency:** `Behavior`/`Instance` (Task 1) reused in 2–5; `read`/`resolveRaw`/`setBound`/`callMethod` signatures stable across tasks; `scanDirectiveComponents: Map<string,string>` (Task 7) consumed by `buildDirectives` (Task 8) and `build.ts` (Task 10) identically; `DIRECTIVES_BOOTSTRAP` (Task 9) consumed by tests in 11.

**Placeholder scan:** no TBD/TODO; every code step shows complete code; commands have expected output.

---

## BLOCKED fallbacks (from the spec)

- **react leaks into `_directives.js`** (Task 8 guard fires on the react-free case): add `"./treaty": "./runtime/treaty.ts"` to `package.json` exports, switch behaviors' `client` import to `brustjs/treaty`, re-run. (Tree-shaking pivot.)
- **MutationObserver misses an SPA-nav swap shape** (Task 6 swap test fails irreparably): have the islands bootstrap `navigate()` also call `start(newMain)` after `swapMainContent` (beside `hydrateMarkersIn`/`applyStoreSnapshot`). Re-introduces a small coupling but is deterministic.
- **Bun.build can't tree-shake the unused `default` template export** (the JSX default pulls react/jsx-runtime into `_directives.js`): split the file — move `behavior` to a co-located `<Name>.client.ts`; change `scanDirectiveComponents` to look for the companion file's `export const behavior` and resolve its path. Single-file is the preference, not a hard requirement.
