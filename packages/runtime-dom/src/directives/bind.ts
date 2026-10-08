import { BINDERS } from './index'
import { parsed, read } from './common'
import { warnOnce } from '../warn'

// Attributes that execute or load code from a string; a bound value must never reach them as-is.
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction'])
const UNSAFE_URL = /^\s*(?:javascript|data:text\/html)/i
const BOOLEAN = new Set(['disabled', 'checked', 'selected', 'readonly', 'required', 'hidden', 'open', 'multiple'])
BINDERS.push({
  match: (a) => a.startsWith('x-bind-'),
  bind: ({ inst, el, attr, raw, scope }) => {
    const name = attr.slice('x-bind-'.length)
    if (name.startsWith('on') || name === 'srcdoc') { warnOnce(`bind:unsafe:${inst.name}:${name}`, `${attr} in ${inst.name} refused (use x-on-*)`); return }
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
      if (v == null || v === false) { el.removeAttribute(name); return }
      if (URL_ATTRS.has(name) && UNSAFE_URL.test(String(v))) { warnOnce(`bind:url:${inst.name}:${name}`, `${attr} in ${inst.name}: unsafe URL refused`); return }
      el.setAttribute(name, String(v))
    })
  },
})
