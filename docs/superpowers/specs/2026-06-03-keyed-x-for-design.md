# B7 — keyed `x-for` diff (reactive per-item) — design

> Status: design · 2026-06-03 · feature B7 (last remaining B7 item). TS-only — touches
> `runtime/native/runtime.ts` ONLY (`bindFor` + `read`). No Rust, no compiler, no napi rebuild.

## Goal

Replace the native directive runtime's `x-for` "v1 full re-render" (clear ALL clones + rebuild on
any list change, `runtime/native/runtime.ts:145-192`) with an **opt-in keyed reconcile** that:

- **reuses DOM nodes** across list updates → focus / scroll / uncontrolled-input state survive
  reorder, insert, delete, and filter.
- is **reactive per-item**: when a kept key's item value (or its position/index) changes, the
  reused node updates in place — without rebuilding it.

Opt-in via a `by <keypath>` clause; existing `x-for="item in items"` keeps the v1 behavior unchanged.

## CLI/authoring surface

```
x-for="(item, i) in items by item.id, item.color"
        └──┬──┘  │     └─┬─┘    └────────┬────────┘
        item +   │     list path     composite key (comma-separated, OPTIONAL)
       index     └ index binding (OPTIONAL)
```

Everything after the item binding is optional. Legal forms:

| expression                                  | mode    | item | index | key            |
|---------------------------------------------|---------|------|-------|----------------|
| `item in items`                             | legacy  | ✓    | —     | — (re-render)  |
| `(item, i) in items`                        | legacy  | ✓    | ✓     | — (re-render)  |
| `item in items by item.id`                  | keyed   | ✓    | —     | `item.id`      |
| `(item, i) in items by item.id`             | keyed   | ✓    | ✓     | `item.id`      |
| `(item, i) in items by item.id, item.color` | keyed   | ✓    | ✓     | composite      |

- **item binding**: `item` or `(item, index)`. Both names are `\w+` identifiers.
- **list path**: `[\w.]+` member path, resolved against the component instance (signal-aware).
- **key clause**: `by` + one-or-more `[\w.]+` keypaths, comma-separated. Each keypath is resolved
  **relative to the child scope** (so `item.id`, `item.color` see the per-clone `item`). A keypath
  may also reference the index (e.g. `by i` — degenerate, equals positional).
- **Composite key value** = each keypath `read()` → `String(part)`, joined with `\x00` (NUL). NUL
  is chosen so distinct part-tuples never collide (`"1","23"` ≠ `"12","3"`).

## High-level architecture

Two changes in `runtime/native/runtime.ts`, both local:

### 1. `read()` — unwrap signals/computeds at EVERY hop (not just the leaf)

Current `read` (line 298) unwraps a signal/computed only at the **leaf** of the dotted path. The
reactive-per-item model stores `childScope[itemName]` as a `Signal<item>`, so `read(scope,"item.name")`
must unwrap the signal at the **intermediate** `item` hop before descending into `.name`.

```ts
export function read(scope: Instance, path: string): unknown {
  let cur: unknown = scope
  const parts = path.split('.')
  for (let i = 0; i < parts.length; i++) {
    if (cur == null) return undefined
    // Unwrap a signal/computed BEFORE descending (intermediate hop). This is what lets
    // effect() track the item-signal: reading `item.name` calls the item signal here.
    if (isSignal(cur) || isComputed(cur)) cur = (cur as () => unknown)()
    cur = (cur as Record<string, unknown>)[parts[i] as string]
  }
  if (isSignal(cur) || isComputed(cur)) return (cur as () => unknown)()
  if (typeof cur === 'function') return (cur as () => unknown)()
  return cur
}
```

Invariants preserved:
- **leaf signal/computed** still unwrapped (the old behavior, regression-tested).
- **plain function at leaf** still called (the old `typeof cur === 'function'` branch) — this is the
  zero-arg method/getter convenience that existed before.
- **plain function at an intermediate hop is NOT called** — only signal/computed are unwrapped
  mid-path. A method sitting mid-path stays a function (descending into it yields `undefined`, same
  as today). This keeps `resolveRaw`/`callMethod` (x-on) semantics untouched — those never call `read`.

### 2. `bindFor()` — parse helper + keyed reconcile branch

**Parser** — replace the single `FOR_RE` with a small structured helper:

```ts
interface ForExpr { itemName: string; indexName?: string; listPath: string; keyPaths?: string[] }
function parseFor(raw: string): ForExpr | null
```

Accepts the grammar above. Returns `null` on malformed input (current warn-and-skip behavior kept).
Implementation is split-based (split on ` in ` then ` by `, parse the item binding, split key clause
on `,`) rather than one mega-regex, for readability + per-branch testability.

**Dispatch:**
- `keyPaths` absent → **legacy path** (existing full re-render). Add index support: if `indexName`
  present, set `childScope[indexName] = i` (plain number — legacy rebuilds every change so no signal
  needed). Otherwise byte-for-byte the current loop.
- `keyPaths` present → **keyed reconcile** (new).

**Keyed reconcile** — maintain `Map<string, ForEntry>` across effect runs:

```ts
interface ForEntry {
  node: HTMLElement
  itemSig: Signal<unknown>
  idxSig?: Signal<number>
  disposers: Array<() => void>
}
```

On each effect run (triggered by the list signal changing):

1. `const list = read(instance, listPath)` — this read tracks the list signal (the ONLY dependency
   the reconcile effect tracks; it must NOT read any item signal, or it would re-trigger itself).
2. Not an array → dispose+remove all current entries, clear map, return.
3. Walk `list` in order. For each `(item, i)`:
   - `key = keyPaths.map(p => String(read(childScopeProbe, p))).join('\x00')` where the key is read
     against a scope exposing `item`/`index` (see note). On **duplicate** key in this pass:
     `console.warn` + use a positional fallback key `${key}\x00#${i}` so the map stays 1:1 (the dup
     occurrence is treated as a fresh node, never reused).
   - **reuse** (old map has key): `batch(() => { entry.itemSig.set(item); entry.idxSig?.set(i) })`,
     `parent.insertBefore(entry.node, anchor)` to place it in the new order, move entry old→new map.
   - **create** (new key): `itemSig = signal(item)`, `idxSig = indexName ? signal(i) : undefined`,
     `childScope = Object.create(instance)`, `childScope[itemName] = itemSig`,
     `childScope[indexName] = idxSig` (if present), clone template, `bindTree(clone, childScope,
     entryDisposers)`, `insertBefore(clone, anchor)`, add to new map.
4. After the walk: every entry remaining in the **old** map (not reused) → run its disposers + remove
   its node.

Ordering: inserting every node before the trailing `anchor` comment in list order yields correct DOM
order (a reused node already in the DOM is *moved*, not cloned, by `insertBefore`). v1 does no
move-minimization — correctness over churn; optimize only if profiling demands (YAGNI).

**Key resolution scope note:** the composite key must be computed from `item`/`index` for each list
element. Compute it against a throwaway scope `{ [itemName]: item, [indexName]: i }` (plain values,
no signal needed — the key read is one-shot, not tracked), via the same `read()` (so `item.id`
member-path works). Do NOT use the per-entry signal scope for key computation (avoids accidental
dependency tracking inside the reconcile effect).

## File structure

- `runtime/native/runtime.ts` — `read()` (unwrap-each-hop), `bindFor()` (parseFor + keyed branch),
  new `parseFor` helper, `ForExpr`/`ForEntry` types. ~120 LOC delta, one file.
- `runtime/native/runtime.test.ts` — extend the existing `describe('x-for')` block.
- No new files. No Rust. No compiler. No `.node` rebuild.

## Behavior invariants

- **Backward compat:** `x-for="item in items"` (no `by`) behaves exactly as before (full re-render).
- **Single dependency:** the reconcile effect tracks only the list signal — never an item signal —
  so `itemSig.set()` inside it cannot re-trigger it (no infinite loop). Verified by: key computed
  from plain scope; item/idx reads happen only inside child-bound effects, which are separate
  `effect()` consumers.
- **Node identity:** a kept key's `node` object is the SAME `HTMLElement` across updates → focus,
  scroll position, and uncontrolled `<input>` value survive.
- **Value reactivity:** changing a kept key's item (new object/value in the list) → `itemSig.set` →
  `Object.is` guard passes (new reference) → child `x-text`/`x-bind-*` effects re-run.
- **Index reactivity (keyed):** reorder changes a kept node's position → `idxSig.set(newPos)` →
  `x-text="i"` updates without rebuild.
- **Mutate-in-place caveat:** `signal.set` has an `Object.is` guard. If a consumer mutates the same
  item object in place (same reference) and re-assigns the list, `itemSig.set(sameRef)` will NOT
  notify. Documented limitation — the framework's reactivity contract is immutable updates (same as
  `defineStore`). Out of scope to deep-equal.
- **Dispose:** removed keys run their per-entry disposers (effect teardown + event listener removal)
  before node removal — no leaks.

## Tests (`runtime/native/runtime.test.ts`, happy-dom)

**parseFor (unit, exported for test):**
- `item in items` → `{itemName, listPath}`
- `(item, i) in items` → `+indexName`
- `item in items by item.id` → `+keyPaths:['item.id']`
- `(item, i) in items by item.id, item.color` → all fields, 2 keyPaths
- malformed (`garbage`, `item in`, `(a,b,c) in x`) → `null`

**read (unit):**
- leaf signal unwrapped (regression)
- intermediate signal unwrapped then descended (`item.name` where `item` is `signal(obj)`) — NEW
- plain nested object path unchanged
- computed at leaf unwrapped
- zero-arg function at leaf called (regression)
- null mid-path → `undefined`

**keyed reconcile (integration, happy-dom):**
- reorder list (swap two keys) → both `node` refs identical pre/post (capture element references)
- insert one key → exactly one new node added, others same refs
- delete one key → that node removed + its disposer ran (spy), others same refs
- value change on kept key → `x-text` content updates, node ref unchanged
- index updates on reorder → `x-text="i"` reflects new position, node ref unchanged
- composite key → two items differing only in 2nd key part are distinct nodes (no collision)
- duplicate key → `console.warn` called, both rendered (no crash)

**focus preservation (integration):**
- focus an `<input>` inside a clone → reorder list → `document.activeElement` is the same node.

**legacy (regression):**
- `x-for="item in items"` (no by) → full re-render path, existing test still green.

## Acceptance criteria

1. `cd runtime && bun run ci` (biome) clean.
2. `cd runtime && bun test native/` green — existing x-for tests pass + new keyed tests pass.
3. `bun test runtime/` full suite no regression (baseline 438 pass).
4. `bun run typecheck:treaty` still 0 (no treaty-graph touch; sanity only).
5. No Rust/compiler change → NO napi rebuild needed (assert: `git diff --stat` shows only
   `runtime/native/runtime.ts` + its test + this spec + the B5 doc closure).
6. Manual smoke (happy-dom or browser): a keyed list with a focused input survives a reorder with
   focus intact and updated values — captured in a test, not just asserted in prose.

## Known limitations (documented, deferred)

- **x-on handlers still can't see `item`** — `x-on-click="method"` resolves a method path on the
  instance; passing the loop item to a handler (`@click="() => remove(item)"`) needs inline-expression
  x-on, which remains a path-only directive. Out of scope; pre-existing.
- **Mutate-in-place items don't update** (Object.is guard) — immutable-update contract, as above.
- **No move-minimization** — reconcile re-inserts every node in order each pass; correct but not
  minimal DOM churn. Reused nodes keep identity (focus survives) regardless; optimize only if needed.
- **Nested keyed x-for** is expected to work via the `Object.create` scope chain (inner clone sees
  outer `item`), but is not a focus of this slice; add a smoke test if cheap.

## Open questions — resolved at design time

- **key syntax** ✅ inline `by`, comma-separated composite (user decision 2026-06-03; colon dropped).
- **index** ✅ supported, reactive in keyed mode (`idxSig`), plain in legacy mode (user decision).
- **reactive-per-item mechanism** ✅ `signal(item)` + `read()` unwrap-each-hop (store has no
  `reactive()` object primitive; only `signal`/`computed`).
- **composite separator** ✅ `\x00` NUL join (collision-safe).
