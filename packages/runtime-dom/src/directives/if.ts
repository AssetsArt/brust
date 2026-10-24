import { BINDERS, bindElement, walkChildren, parsed, read, hooks } from '../core-api'
/** The callback refs of the branch being inserted: attached once its whole subtree is bound and mounted (React attaches
 * refs in the commit, after the DOM is placed and before layout effects); an inner branch's attach first. */
let attach: Array<() => void> | null = null
BINDERS.push({
  match: (a) => a === 'x-if',
  bind: ({ inst, el, attr, raw, scope }) => {
    const p = parsed(inst, attr, raw); if (!p) return
    const anchor = document.createComment('x-if')
    const template = el.cloneNode(true) as Element
    template.removeAttribute('x-if'); template.removeAttribute('hidden')
    el.replaceWith(anchor)                 // the server-rendered element becomes the first clone below
    let current: Element | null = null
    // F415/F416: what the branch bound (its effects, its x-ref) is let go before the element leaves, as React detaches
    // a removed host's refs in the same commit.
    let drop = () => {}
    const remove = () => { drop(); drop = () => {}; current?.remove(); current = null }   // the observer disposes nested hosts
    inst.effect(() => {
      const r = read(inst, p, scope, attr); if (!r.ok) return
      const want = Boolean(r.value)
      if (want && !current) {
        const node = (current = template.cloneNode(true) as Element)
        anchor.after(node)
        const outer = attach; const mine: Array<() => void> = (attach = [])
        try {
          // nested hosts mount inside the capture too: an `x-cref` on one registers its detach on this branch
          drop = inst.capture(() => { bindElement(inst, node, scope); walkChildren(inst, node, scope); hooks.mountTree(node) })
        } finally { attach = outer }
        for (const f of mine) f()
      } else if (!want && current) remove()
    })
    inst.onCleanup(remove)
  },
})
// F288 phase B (G5): `x-cref="cell"`, a callback ref inside a branch. The cell holds the callback (or a ref object); it
// gets the node when the branch is inserted and `null` (or the callback's returned cleanup) when it is removed. On a
// nested host the host's own instance meets it while it mounts, inside the branch's capture.
BINDERS.push({
  match: (a) => a === 'x-cref',
  bind: ({ inst, el, raw }) => {
    // on a nested host (an inlined native child's root) the cell is the caller's, as `x-pref`'s is
    const owner = el === inst.host ? inst.parent : inst
    if (!owner) return
    const r = owner.ref(raw.trim()).current as unknown
    let off: (() => void) | void
    owner.onCleanup(() => { off?.(); off = undefined })
    const on = () => {
      if (typeof r === 'function') { const c = r(el); off = typeof c === 'function' ? c : () => r(null) }
      else if (r) { (r as { current: unknown }).current = el; off = () => { (r as { current: unknown }).current = null } }
    }
    attach ? attach.push(on) : on()
  },
})
