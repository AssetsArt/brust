import { BINDERS } from './index'
import { parsed, read } from './common'
BINDERS.push({
  match: (a) => a === 'x-show',
  bind: ({ inst, el, attr, raw, scope }) => {
    const p = parsed(inst, attr, raw); if (!p) return
    inst.effect(() => {
      const r = read(inst, p, scope, attr); if (!r.ok) return
      ;(el as HTMLElement).style.display = r.value ? '' : 'none'
    })
  },
})
