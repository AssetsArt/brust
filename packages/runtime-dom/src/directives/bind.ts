import { reactEvent } from './on'
import { BINDERS, parsed, read, warnOnce } from '../core-api'
import { BOOLEAN, OVERLOADED, STRINGIFY } from '../attr-kinds'
import type { Instance } from '../instance'

// Attributes that execute or load code from a string; a bound value must never reach them as-is.
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'poster', 'data', 'xlink:href', 'ping'])
// Scheme allowlist on the parsed URL (relative URLs resolve to http): new URL() applies the browser's tab/newline/control-char stripping.
const safeUrl = (v: string): boolean => { try { return ['http:', 'https:', 'mailto:', 'tel:'].includes(new URL(v, 'http://x').protocol) } catch { return false } }
/** Writes one bound attribute value with React's rules (shared by `x-bind-*` and `x-prop-*`, A2: one print path). */
function writeAttr(inst: Instance, attr: string, el: Element, name: string, v: unknown): void {
  // setAttribute: `className` is a getter-only SVGAnimatedString on SVG elements (F96a).
  // F311: undefined/null removes `class` (React does; `className=""` keeps an empty one), and an empty `style` is no attribute (the first paint omits it)
  if (name === 'class') { if (v == null) el.removeAttribute('class'); else el.setAttribute('class', `${v}`); return }
  // F434: a multiple select is bound to an array, one pick per option (`null`/`undefined` leave the picks alone, as React does)
  if (name === 'value' && el instanceof HTMLSelectElement && el.multiple) { if (v != null) { const vs = ([] as unknown[]).concat(v).map(String); for (const o of el.options) o.selected = vs.includes(o.value) } return }
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
}

BINDERS.push({
  match: (a) => a.startsWith('x-bind-'),
  bind: ({ inst, el, attr, raw, scope }) => {
    const name = attr.slice('x-bind-'.length)
    if (name.startsWith('on') || name === 'srcdoc') { warnOnce(`b:${inst.name}:${name}`, `${attr} in ${inst.name} refused (use x-on-*)`); return }
    const p = parsed(inst, attr, raw); if (!p) return
    inst.effect(() => {
      const r = read(inst, p, scope, attr); if (!r.ok) return
      writeAttr(inst, attr, el, name, r.value)
    })
  },
})

// F329b: `x-prop-<attribute>="<prop key>"` binds the attribute to a prop of THIS instance (`inst.props()`), the key being
// the VALUE (a prop key is not a member path: `aria-checked`, `tabIndex`). The key set is a property of one call site, so it is
// printed in the template, never as a chunk member (the chunk stays shared). The attribute name is the lowercase DOM name the
// server print used (the shared React -> attribute table), so both ends agree.
// Refused, as `x-bind-*` refuses them and more: event handlers, `srcdoc`, `x-*`, and the keys the server print never
// binds through a spread (class, style, value, checked, selected, URL-bearing attributes).
const PROP_REFUSED = new Set(['srcdoc', 'class', 'style', 'value', 'checked', 'selected', ...URL_ATTRS])
BINDERS.push({
  match: (a) => a.startsWith('x-prop-'),
  bind: ({ inst, el, attr, raw }) => {
    const name = attr.slice('x-prop-'.length)
    // F369c: `x-prop-on-<event>="<prop key>"` calls the instance's prop (a function a caller handed through the child's rest)
    // with the event, reading it at call time so a prop that changes is the one that runs. The event is `[a-z0-9]+`.
    if (name.startsWith('on-')) {
      const event = name.slice(3)
      if (!raw || !/^[a-z0-9]+$/.test(event)) { warnOnce(`pb:${inst.name}:${name}`, `${attr} in ${inst.name} refused`); return }
      const handler = (e: Event) => {
        reactEvent(e)
        const ps = inst.props(); const fn = Object.hasOwn(ps, raw) ? ps[raw] : undefined
        if (typeof fn === 'function') (fn as (e: Event) => void)(e)
      }
      el.addEventListener(event, handler)
      inst.onCleanup(() => el.removeEventListener(event, handler))
      return
    }
    if (!name || !raw || name.startsWith('on') || name.startsWith('x-') || PROP_REFUSED.has(name)) {
      warnOnce(`pb:${inst.name}:${name}`, `${attr} in ${inst.name} refused`); return
    }
    inst.effect(() => { const ps = inst.props(); writeAttr(inst, attr, el, name, Object.hasOwn(ps, raw) ? ps[raw] : undefined) })
  },
})
