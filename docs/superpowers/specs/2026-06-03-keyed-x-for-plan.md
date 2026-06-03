# B7 keyed `x-for` — implementation plan

Spec: `docs/superpowers/specs/2026-06-03-keyed-x-for-design.md`. TS-only, one source file
(`runtime/native/runtime.ts`) + its test (`runtime/native/runtime.test.ts`). No Rust/compiler/napi.

All commands run from `/Users/detoro/code/brust`. Test command per task:
`cd runtime && bun test native/runtime.test.ts` (fast, file-scoped). Final gate uses the full suite.

## Spec coverage table

| Spec section | Task |
|---|---|
| Parser grammar / `parseFor` | Task 1 |
| `read()` unwrap-each-hop + regression | Task 2 |
| Keyed reconcile + index + per-entry/unmount disposal | Task 3 |
| Legacy backward-compat + legacy index | Task 3 |
| Tests: parseFor / read / reconcile / focus / unmount / dup | Tasks 1-3 |

---

## Task 1 — `parseFor` helper (replace `FOR_RE`)

### 1a. RED — parser unit tests
Add a `describe('parseFor', ...)` block to `runtime/native/runtime.test.ts`. `parseFor` is currently
not exported; export it from `runtime.ts` (Task 1b). Import via the fresh-module pattern.

```ts
describe('parseFor', () => {
  test('grammar forms', async () => {
    const { parseFor } = await import(`./runtime.ts?pf=${Math.random()}`)
    expect(parseFor('t in items')).toEqual({ itemName: 't', indexName: undefined, listPath: 'items', keyPaths: undefined })
    expect(parseFor('(t, i) in items')).toEqual({ itemName: 't', indexName: 'i', listPath: 'items', keyPaths: undefined })
    expect(parseFor('t in items by t.id')).toEqual({ itemName: 't', indexName: undefined, listPath: 'items', keyPaths: ['t.id'] })
    expect(parseFor('(t, i) in items by t.id, t.color')).toEqual({ itemName: 't', indexName: 'i', listPath: 'items', keyPaths: ['t.id', 't.color'] })
    // malformed → null
    for (const bad of ['garbage', 't in', 'in items', '(a,b,c) in x', 't in items by', 't in items by !', 't in it ems']) {
      expect(parseFor(bad)).toBeNull()
    }
  })
})
```

### 1b. GREEN — implement `parseFor`, delete `FOR_RE`
In `runtime/native/runtime.ts`, remove `const FOR_RE = ...` (line ~139) and add:

```ts
export interface ForExpr {
  itemName: string
  indexName?: string
  listPath: string
  keyPaths?: string[]
}

const PATH_RE = /^[\w.]+$/
const ITEM_RE = /^(?:\(\s*(\w+)\s*,\s*(\w+)\s*\)|(\w+))$/

/** Parse an x-for expression. Grammar:
 *   (item[, index]) in listPath [by keyPath, keyPath, ...]
 * Returns null on malformed input (caller warns + skips). */
export function parseFor(raw: string): ForExpr | null {
  const trimmed = raw.trim()
  let head = trimmed
  let keyPart: string | undefined
  const byIdx = trimmed.search(/\sby\s/)
  if (byIdx !== -1) {
    head = trimmed.slice(0, byIdx)
    keyPart = trimmed.slice(byIdx + 4) // skip " by "
  }
  const m = /^(.*?)\s+in\s+(.+)$/.exec(head.trim())
  if (!m) return null
  const itemRaw = (m[1] as string).trim()
  const listPath = (m[2] as string).trim()
  if (!PATH_RE.test(listPath)) return null
  const im = ITEM_RE.exec(itemRaw)
  if (!im) return null
  const itemName = (im[1] ?? im[3]) as string
  const indexName = im[2] // undefined for the simple form
  let keyPaths: string[] | undefined
  if (keyPart !== undefined) {
    keyPaths = keyPart.split(',').map((s) => s.trim())
    if (keyPaths.length === 0 || keyPaths.some((p) => !PATH_RE.test(p))) return null
  }
  return { itemName, indexName, listPath, keyPaths }
}
```

Do NOT change `bindFor` yet beyond swapping the parse call (Task 3 rewrites the body). Minimal wiring:
in `bindFor`, replace the `FOR_RE.exec` block with `const expr = parseFor(raw); if (!expr) { warn; return }`
and destructure `itemName`/`listPath` so the existing legacy loop keeps compiling. (Task 3 finishes it.)

**Verify:** `cd runtime && bun test native/runtime.test.ts` — parseFor tests green, existing x-for tests
still green (legacy still uses itemName/listPath).

**BLOCKED fallback:** if the ` by ` split misfires on an edge (e.g. a key path literally named with a
`by` token), tighten to a single regex:
`/^\(?\s*(\w+)(?:\s*,\s*(\w+))?\s*\)?\s+in\s+([\w.]+)(?:\s+by\s+([\w.,\s]+))?$/` and split group 4 on `,`.

---

## Task 2 — `read()` unwrap signals at every hop

### 2a. RED — read regression + intermediate-signal tests
Add `describe('read', ...)`. `read` is already exported.

```ts
describe('read (unwrap each hop)', () => {
  test('leaf + intermediate + plain + computed + fn + null', async () => {
    const { read } = await import(`./runtime.ts?rd=${Math.random()}`)
    const { signal, computed } = await import('../store/index.ts')
    // leaf signal (regression)
    expect(read({ n: signal(5) }, 'n')).toBe(5)
    // intermediate signal unwrapped then descended (NEW)
    expect(read({ item: signal({ name: 'fire' }) }, 'item.name')).toBe('fire')
    // plain nested path unchanged
    expect(read({ a: { b: 'x' } }, 'a.b')).toBe('x')
    // computed at leaf
    expect(read({ c: computed(() => 9) }, 'c')).toBe(9)
    // zero-arg function at leaf called (regression)
    expect(read({ f: () => 'r' }, 'f')).toBe('r')
    // null mid-path
    expect(read({ a: null }, 'a.b')).toBeUndefined()
  })
})
```

### 2b. GREEN — implement
Replace `read` (line ~298) with:

```ts
export function read(scope: Instance, path: string): unknown {
  let cur: unknown = scope
  for (const part of path.split('.')) {
    if (cur == null) return undefined
    // Unwrap a signal/computed BEFORE descending (intermediate hop) so reading
    // `item.name` calls the item signal here → effect() tracks it. Plain functions
    // are NOT called mid-path (only signal/computed), preserving x-on/method semantics.
    if (isSignal(cur) || isComputed(cur)) cur = (cur as () => unknown)()
    cur = (cur as Record<string, unknown>)[part]
  }
  if (isSignal(cur) || isComputed(cur)) return (cur as () => unknown)()
  if (typeof cur === 'function') return (cur as () => unknown)()
  return cur
}
```

**Verify:** `cd runtime && bun test native/runtime.test.ts` — read tests green, ALL existing tests green
(this is the regression-risk change; the full existing suite must stay green).

**BLOCKED fallback:** if any existing test regresses because a current path had a plain function at an
intermediate hop being descended-into (none found in review, but if so), the change is still correct —
investigate the specific test; do NOT special-case functions mid-path (that breaks the design).

---

## Task 3 — keyed reconcile `bindFor` (the core)

### 3a. RED — reconcile / index / composite / dup / focus / unmount tests
Extend `describe('x-for', ...)`. Key tests (write all):

```ts
test('keyed: reorder preserves node identity', async () => {
  const win = setupDom('<ul x-data="k1"><li x-for="t in items by t.id" x-text="t.name"></li></ul>')
  const { register, start } = await import(`./runtime.ts?k1=${Math.random()}`)
  const { signal } = await import('../store/index.ts')
  const items = signal([{ id: 1, name: 'a' }, { id: 2, name: 'b' }])
  register('k1', () => ({ items }))
  start(win.document)
  const ul = win.document.querySelector('ul')!
  const before = Array.from(ul.querySelectorAll('li'))
  items.set([{ id: 2, name: 'b' }, { id: 1, name: 'a' }]) // swap
  const after = Array.from(ul.querySelectorAll('li'))
  expect(after.map((l) => l.textContent)).toEqual(['b', 'a'])
  expect(after[0]).toBe(before[1]) // SAME node object — reused, not rebuilt
  expect(after[1]).toBe(before[0])
})

test('keyed: value change on kept key updates same node', async () => {
  // id stable, name changes → x-text updates, node ref identical
  const items = signal([{ id: 1, name: 'old' }])
  // ... after items.set([{id:1,name:'new'}]) → li[0] same ref, textContent 'new'
})

test('keyed: index reactive on reorder', async () => {
  // x-for="(t, i) in items by t.id", body x-text="i"
  // reorder → kept nodes show new index, same node refs
})

test('keyed: insert/delete touch only changed keys', async () => {
  // capture refs; insert one → exactly one new node, others ===; delete one → that node gone
})

test('keyed: composite key avoids collision', async () => {
  // by t.a, t.b — items [{a:1,b:23},{a:12,b:3}] are two distinct nodes
})

test('keyed: duplicate key warns, does not crash', async () => {
  const warn = console.warn
  const calls: any[] = []
  console.warn = (...a: any[]) => calls.push(a)
  try {
    // items with two id:1 → 2 nodes rendered, warn called
  } finally { console.warn = warn }
})

test('keyed: focus survives reorder', async () => {
  // <input x-bind-value=...> inside clone, focus it, reorder, document.activeElement === same node
})

test('keyed: unmount disposes all live entries', async () => {
  // mount keyed list, spy that a child effect stops after host removed from DOM / disposeTree
})

test('legacy index: (t, i) in items without by', async () => {
  // x-text="i" renders positions; full re-render still works
})
```

(Flesh out the stubbed bodies following the first test's shape. For unmount, simplest is to remove the
host `[x-data]` node and let the MutationObserver `disposeTree` run, or call the returned disposer.)

### 3b. GREEN — implement keyed reconcile + legacy index
Imports at top of `runtime.ts`: add `signal`, `batch`, and type `Signal`:
```ts
import { batch, effect, isComputed, isSignal, signal } from '../store/index.ts'
import type { Signal } from '../store/index.ts'
```

Rewrite `bindFor` (replace lines ~145-192):

```ts
interface ForEntry {
  node: HTMLElement
  itemSig: Signal<unknown>
  idxSig?: Signal<number>
  disposers: Array<() => void>
}

function bindFor(tplEl: HTMLElement, instance: Instance, disposers: Array<() => void>): void {
  const expr = parseFor(tplEl.getAttribute('x-for') ?? '')
  if (!expr) {
    console.warn(`[brust] malformed x-for expression: "${tplEl.getAttribute('x-for')}"`)
    return
  }
  const { itemName, indexName, listPath, keyPaths } = expr
  const parent = tplEl.parentNode
  if (!parent) return
  const anchor = tplEl.ownerDocument.createComment(`x-for:${itemName}`)
  parent.insertBefore(anchor, tplEl)
  tplEl.removeAttribute('x-for')
  const template = tplEl.cloneNode(true) as HTMLElement
  tplEl.remove()

  // ---- legacy (no `by`) — full re-render, with optional plain index ----
  if (!keyPaths) {
    const rendered: HTMLElement[] = []
    const childDisposers: Array<() => void> = []
    const clear = () => {
      for (const d of childDisposers.splice(0)) {
        try { d() } catch { /* keep clearing */ }
      }
      for (const node of rendered.splice(0)) node.remove()
    }
    disposers.push(
      effect(() => {
        clear()
        const list = read(instance, listPath)
        if (!Array.isArray(list)) return
        for (let i = 0; i < list.length; i++) {
          const clone = template.cloneNode(true) as HTMLElement
          const childScope: Instance = Object.create(instance)
          childScope[itemName] = list[i]
          if (indexName) childScope[indexName] = i
          bindTree(clone, childScope, childDisposers)
          parent.insertBefore(clone, anchor)
          rendered.push(clone)
        }
      }),
    )
    disposers.push(clear)
    return
  }

  // ---- keyed reconcile ----
  let map = new Map<string, ForEntry>()
  const disposeEntry = (e: ForEntry) => {
    for (const d of e.disposers.splice(0)) {
      try { d() } catch { /* keep tearing down */ }
    }
    e.node.remove()
  }
  disposers.push(
    effect(() => {
      const list = read(instance, listPath) // tracks ONLY the list signal
      const arr = Array.isArray(list) ? list : []
      const next = new Map<string, ForEntry>()
      for (let i = 0; i < arr.length; i++) {
        const item = arr[i]
        const probe: Instance = { [itemName]: item } // plain scope → key read tracks nothing
        if (indexName) probe[indexName] = i
        let key = (keyPaths as string[]).map((p) => String(read(probe, p))).join('\x00')
        if (next.has(key)) {
          console.warn(`[brust] duplicate x-for key "${key}"`)
          key = `${key}\x00#${i}`
        }
        const existing = map.get(key)
        if (existing) {
          batch(() => {
            existing.itemSig.set(item)
            existing.idxSig?.set(i)
          })
          parent.insertBefore(existing.node, anchor) // move into new order
          map.delete(key)
          next.set(key, existing)
        } else {
          const clone = template.cloneNode(true) as HTMLElement
          const itemSig = signal(item)
          const idxSig = indexName ? signal(i) : undefined
          const childScope: Instance = Object.create(instance)
          childScope[itemName] = itemSig
          if (indexName && idxSig) childScope[indexName] = idxSig
          const entryDisposers: Array<() => void> = []
          bindTree(clone, childScope, entryDisposers)
          parent.insertBefore(clone, anchor)
          next.set(key, { node: clone, itemSig, idxSig, disposers: entryDisposers })
        }
      }
      for (const e of map.values()) disposeEntry(e) // not reused this pass → gone
      map = next
    }),
  )
  // component-unmount teardown of all live entries (mirrors legacy `clear`)
  disposers.push(() => {
    for (const e of map.values()) disposeEntry(e)
    map.clear()
  })
}
```

**Verify:** `cd runtime && bun test native/runtime.test.ts` — all keyed + legacy + parseFor + read green.

**BLOCKED fallback:** if `insertBefore` move-on-reorder causes a happy-dom quirk (node already child),
it's still correct (insertBefore of an existing child moves it). If focus is lost in happy-dom on
move, verify against a real browser in Phase 6 — happy-dom focus emulation is weaker than Chrome.

---

## Final gate (run before declaring Task 3 done)
1. `cd runtime && bun test native/` — native suite green
2. `cd runtime && bun test` (or `bun test runtime/` from root) — full suite, baseline 438 + new tests
3. `cd runtime && bun run ci` — biome clean (root: `bun run ci`)
4. `bun run typecheck:treaty` — still 0 (sanity; not in treaty graph)
5. `git diff --stat` shows ONLY `runtime/native/runtime.ts` + `runtime/native/runtime.test.ts`
   (+ the already-committed spec/plan/B5 docs) — no Rust, no other source

## Notes for the implementer
- Do NOT touch `resolveRaw`/`callMethod` — x-on stays path-only.
- Do NOT migrate existing `x-for` usages to keyed — backward compat is a hard requirement.
- Keys are assumed plain data (no signals on the key path) — that's the documented contract; do not
  add deep handling for signal-valued keys.
- `signal.set` has an `Object.is` guard: immutable list updates (new item objects) notify; in-place
  mutation does not — this is intended.
