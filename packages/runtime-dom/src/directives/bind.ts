import { BINDERS } from './index'
import { parsed, read } from './common'
const BOOLEAN = new Set(['disabled', 'checked', 'selected', 'readonly', 'required', 'hidden', 'open', 'multiple'])
BINDERS.push({
  match: (a) => a.startsWith('x-bind-'),
  bind: ({ inst, el, attr, raw, scope }) => {
    const name = attr.slice('x-bind-'.length)
    const p = parsed(inst, attr, raw); if (!p) return
    inst.effect(() => {
      const r = read(inst, p, scope, attr); if (!r.ok) return
      const v = r.value
      if (name === 'class') { (el as HTMLElement).className = v == null ? '' : String(v); return }
      if (name === 'value' && 'value' in el) { (el as HTMLInputElement).value = v == null ? '' : String(v); return }
      if (BOOLEAN.has(name)) {
        const on = Boolean(v)
        if (name in el) (el as unknown as Record<string, unknown>)[name] = on
        if (on) el.setAttribute(name, '') ; else el.removeAttribute(name)
        return
      }
      if (v == null || v === false) el.removeAttribute(name); else el.setAttribute(name, String(v))
    })
  },
})
