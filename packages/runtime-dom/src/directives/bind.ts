import { BINDERS, parsed, read, warnOnce } from '../core-api'
import { BOOLEAN, OVERLOADED, STRINGIFY } from '../attr-kinds'

// Attributes that execute or load code from a string; a bound value must never reach them as-is.
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'poster', 'data', 'xlink:href', 'ping'])
// Scheme allowlist on the parsed URL (relative URLs resolve to http): new URL() applies the browser's tab/newline/control-char stripping.
const safeUrl = (v: string): boolean => { try { return ['http:', 'https:', 'mailto:', 'tel:'].includes(new URL(v, 'http://x').protocol) } catch { return false } }
BINDERS.push({
  match: (a) => a.startsWith('x-bind-'),
  bind: ({ inst, el, attr, raw, scope }) => {
    const name = attr.slice('x-bind-'.length)
    if (name.startsWith('on') || name === 'srcdoc') { warnOnce(`b:${inst.name}:${name}`, `${attr} in ${inst.name} refused (use x-on-*)`); return }
    const p = parsed(inst, attr, raw); if (!p) return
    inst.effect(() => {
      const r = read(inst, p, scope, attr); if (!r.ok) return
      const v = r.value
      // setAttribute: `className` is a getter-only SVGAnimatedString on SVG elements (F96a).
      // F311: undefined/null removes `class` (React does; `className=""` keeps an empty one), and an empty `style` is no attribute (the first paint omits it)
      if (name === 'class') { if (v == null) el.removeAttribute('class'); else el.setAttribute('class', `${v}`); return }
      if (name === 'value' && 'value' in el) { (el as HTMLInputElement).value = v == null ? '' : String(v); return }
      // React passes every attribute of a custom element (a tag with `-`) through as given: `true` is ``, `false` omits it.
      const custom = el.localName.includes('-')
      if (!custom && BOOLEAN.has(name)) {
        const on = Boolean(v)
        if (name in el) (el as unknown as Record<string, unknown>)[name] = on
        if (on) el.setAttribute(name, '') ; else el.removeAttribute(name)
        return
      }
      // aria-*, data-* and the booleanish strings print `true`/`false`; download/capture print `true` as ``; on any other attribute React omits a boolean.
      if (!custom && (name.startsWith('aria-') || name.startsWith('data-') || STRINGIFY.has(name))) { if (v == null) el.removeAttribute(name); else el.setAttribute(name, String(v)); return }
      if ((custom || OVERLOADED.has(name)) && typeof v === 'boolean') { if (v) el.setAttribute(name, ''); else el.removeAttribute(name); return }
      if (v == null || typeof v === 'boolean' || (name === 'style' && !v)) { el.removeAttribute(name); return }
      // React writes no `src=""` / `href=""` (it would load the page again); an anchor keeps its empty href.
      if (v === '' && (name === 'src' || name === 'href') && el.localName !== 'a' && !custom) { el.removeAttribute(name); return }
      if (URL_ATTRS.has(name) && !safeUrl(String(v))) { warnOnce(`b:${inst.name}:${name}`, `${attr} in ${inst.name}: unsafe URL refused`); return }
      el.setAttribute(name, String(v))
    })
  },
})
