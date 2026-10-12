import { BINDERS } from './index'
import { parsed, read, mismatch } from './common'
/** Both sides through the HTML parser (inert `<template>`), so `<br/>` vs `<br>` or entity spelling is not a mismatch. */
function sameMarkup(el: Element, next: string): boolean {
  const t = document.createElement('template'); t.innerHTML = next
  return t.innerHTML === el.innerHTML
}
// `x-html` is emitted only by the compiler, for a `dangerouslySetInnerHTML` whose value changes after first paint.
BINDERS.push({
  match: (a) => a === 'x-html',
  bind: ({ inst, el, attr, raw, scope }) => {
    const p = parsed(inst, attr, raw); if (!p) return
    let first = true
    inst.effect(() => {
      const r = read(inst, p, scope, attr); if (!r.ok) return
      const next = r.value == null ? '' : String(r.value)
      if (first) { first = false; if (!sameMarkup(el, next)) { mismatch(inst, attr, el, el.innerHTML, next); el.innerHTML = next }; return }
      el.innerHTML = next
    })
  },
})
