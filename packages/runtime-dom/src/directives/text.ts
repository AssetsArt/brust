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
