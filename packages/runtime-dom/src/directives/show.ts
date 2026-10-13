import { BINDERS, parsed, read } from '../core-api'
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
