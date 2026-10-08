import { BINDERS } from './index'
import { parsed, member } from './common'
BINDERS.push({
  match: (a) => a.startsWith('x-on-'),
  bind: ({ inst, el, attr, raw, scope }) => {
    const event = attr.slice('x-on-'.length)
    const p = parsed(inst, attr, raw); if (!p) return
    const handler = (e: Event) => {
      const fn = member(inst, p, attr)
      if (typeof fn !== 'function') return
      const args = p.bindings.map((b) => scope[b])
      ;(fn as (...a: unknown[]) => void)(...args, e)
    }
    el.addEventListener(event, handler)
    inst.onCleanup(() => el.removeEventListener(event, handler))
  },
})
