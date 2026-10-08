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
