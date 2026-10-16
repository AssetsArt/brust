// The collection feature (R34.140-R34.141): the items a Radix `createCollection` tracks, as the DOM already has them.
// A root is an element with `x-collection-root`; an item is an element with `data-radix-collection-item` whose NEAREST root
// above it is that root (a collection nested inside another keeps its items to itself). Document order is the DOM's own,
// so there is no registry to sort. An item's data (`id`, `focusable`, ...) is what its host's `x-collection-item` member
// evaluates to when asked: read at call time, so it is never stale.
import { BINDERS, collectionHooks, parsed, read } from '../core-api'
import type { CollectionItem } from '../core-api'

const ROOT = '[x-collection-root]'
const ITEM = '[data-radix-collection-item]'
const DATA = new WeakMap<Element, () => unknown>()

collectionHooks.items = (from) => {
  const root = from.closest(ROOT)
  if (!root) return []
  const out: CollectionItem[] = []
  for (const el of Array.from(root.querySelectorAll(ITEM))) {
    // the nearest root ABOVE the item (not the item itself, which may be a root of its own)
    if (el.parentElement?.closest(ROOT) !== root) continue
    const d = DATA.get(el)?.()
    out.push({ ...(d && typeof d === 'object' ? (d as object) : {}), ref: { current: el }, element: el })
  }
  return out
}

// markers: a root, and a host that reads `ctx.items()` (so the module loads for it); neither binds anything
BINDERS.push({ match: (a) => a === 'x-collection-root' || a === 'x-collection-use', bind: () => {} })
BINDERS.push({
  match: (a) => a === 'x-collection-item',
  bind: ({ inst, el, attr, raw, scope }) => {
    const p = parsed(inst, attr, raw)
    if (!p) return
    DATA.set(el, () => { const r = read(inst, p, scope, attr); return r.ok ? r.value : undefined })
    inst.onCleanup(() => DATA.delete(el))
  },
})
