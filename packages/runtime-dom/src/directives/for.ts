import { BINDERS, bindElement, walkChildren } from './index'
import { parsed, read, member } from './common'
import { warnOnce } from '../warn'
import { computed, signal, type Signal } from '../signal'

type RowScope = Record<string, unknown> & { __own: Signal<number> }

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
    // Server-rendered rows (not the hidden zero-row template) are adopted in order on the first run.
    const adopt = siblings.filter((s) => !s.hasAttribute('hidden'))
    if (!adopt.includes(el)) el.remove()
    let firstRun = true

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
        if (node) {
          // Reused row: refresh its scope and poke its tick so every binder that read the scope re-runs.
          const rs = (node as unknown as { __scope: RowScope }).__scope
          if (!Object.is(rs[itemName], item) || (indexName && rs[indexName] !== i)) {
            rs[itemName] = item; if (indexName) rs[indexName] = i
            rs.__own.set((n) => n + 1)
          }
        }
        if (!node) {
          const adopted = firstRun ? adopt.shift() : undefined
          node = adopted ?? (template.cloneNode(true) as Element)
          adopted?.removeAttribute('x-for')
          const own = signal(0)
          const outer = scope.__tick as (() => number) | undefined
          const rowScope: RowScope = { ...scope, [itemName]: item, ...(indexName ? { [indexName]: i } : {}), __own: own, __tick: computed(() => (outer ? outer() : 0) + own()) }
          ;(node as unknown as { __scope: RowScope }).__scope = rowScope
          // a row that is itself a nested host is bound by its own instance
          if (!node.hasAttribute('x-data')) { bindElement(inst, node, rowScope); walkChildren(inst, node, rowScope) }
        }
        ;(next.get(key) ?? next.set(key, []).get(key)!).push(node)
        nextOrder.push(node)
      })
      for (const [, pool] of rows) for (const stale of pool) stale.remove()
      for (const left of adopt.splice(0)) left.remove()
      firstRun = false
      // place in order after the anchor
      let ref: Node = anchor
      for (const node of nextOrder) { if (ref.nextSibling !== node) parent.insertBefore(node, ref.nextSibling); ref = node }
      rows = next; order = nextOrder
    })
    inst.onCleanup(() => { for (const n of order) n.remove() })
  },
})
