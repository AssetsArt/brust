// SKETCH ONLY (never shipped): the least a generic client `x-spread` sink must do, mirroring brust-jinja `spread_attrs`.
const NAME = /^[A-Za-z_:][-A-Za-z0-9_:.]*$/
const ALIAS = { className: 'class', htmlFor: 'for', tabIndex: 'tabindex', readOnly: 'readonly', maxLength: 'maxlength', colSpan: 'colspan', rowSpan: 'rowspan', acceptCharset: 'accept-charset', httpEquiv: 'http-equiv', crossOrigin: 'crossorigin', autoComplete: 'autocomplete', autoFocus: 'autofocus', contentEditable: 'contenteditable', spellCheck: 'spellcheck', srcSet: 'srcset', useMap: 'usemap', dateTime: 'datetime', encType: 'enctype', formAction: 'formaction', noValidate: 'novalidate' }
const BOOL = new Set(['disabled', 'hidden', 'required', 'readonly', 'multiple', 'autofocus', 'open', 'novalidate', 'checked', 'selected', 'controls', 'loop', 'muted', 'autoplay', 'default', 'reversed', 'async', 'defer'])
const URLS = new Set(['href', 'src', 'action', 'formaction', 'poster', 'cite', 'data', 'ping', 'background'])
const UNITLESS = new Set(['zIndex', 'opacity', 'flex', 'flexGrow', 'flexShrink', 'fontWeight', 'lineHeight', 'order', 'zoom'])
const css = (o) => Object.entries(o && typeof o === 'object' ? o : {}).filter(([k, v]) => v != null && v !== false && /^(--[\w-]+|[A-Za-z][\w-]*)$/.test(k)).map(([k, v]) => [k, typeof v === 'number' ? (v === 0 || UNITLESS.has(k) || k.startsWith('--') ? String(v) : v + 'px') : String(v)]).filter(([, v]) => v !== '' && !/[;{}\\\n\r]|\/\*|expression\(|@import/i.test(v)).map(([k, v]) => (k.startsWith('--') ? k : k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())) + ':' + v).join(';')
const safeUrl = (s) => !/^\s*(javascript|data|vbscript):/i.test(s)
export function spread(el, obj, keys) {
  for (const key of keys) {
    const name = ALIAS[key] ?? key
    const v = obj?.[key]
    if (!NAME.test(name) || /^(on|x-)/i.test(name) || name === 'srcdoc' || key === 'children' || key === 'key' || key === 'ref' || key === 'dangerouslySetInnerHTML') continue
    if (name === 'style') { const s = css(v); s ? el.setAttribute('style', s) : el.removeAttribute('style'); continue }
    if (v == null || v === false && !/^(aria-|data-)/.test(name)) { el.removeAttribute(name); continue }
    if (BOOL.has(name)) { el.toggleAttribute(name, !!v); continue }
    const s = String(v)
    if (URLS.has(name) && !safeUrl(s)) { el.removeAttribute(name); continue }
    el.setAttribute(name, s)
  }
}
