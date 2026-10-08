import { BINDERS } from './index'
BINDERS.push({
  match: (a) => a === 'x-ref',
  bind: ({ inst, el, raw }) => {
    const r = inst.ref(raw.trim())
    r.current = el as HTMLElement
    inst.onCleanup(() => { if (r.current === el) r.current = null })
  },
})
