import { BINDERS, bindElement, walkChildren, parsed, read, hooks } from '../core-api'
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
        drop = inst.capture(() => { bindElement(inst, node, scope); walkChildren(inst, node, scope) })
        hooks.mountTree(node)
      } else if (!want && current) remove()
    })
    inst.onCleanup(remove)
  },
})
