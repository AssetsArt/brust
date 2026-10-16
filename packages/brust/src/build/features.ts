// Which client-runtime feature modules a component needs (L33, R35.2). The compiler's output is the source of truth:
// a native component's template carries one `x-*` attribute per directive it uses, a react-tier component is an island.
// The set is written per component into the manifest; the server unions it over a route's components and links the
// core plus exactly those modules. `packages/runtime-dom/README.md` ("Feature modules") owns the module list and the rule.
import { BuildError } from './errors'

/** Feature modules of `@brust/runtime-dom/features/*` the browser build ships, in load order. */
export const RUNTIME_FEATURES = ['basics', 'if', 'for', 'model', 'html', 'island', 'collection'] as const
export type RuntimeFeature = (typeof RUNTIME_FEATURES)[number]

/** Directive attribute → the module that binds it. `null`: handled by the core (host, props, inert-markup marker). */
export function featureOfAttr(attr: string): RuntimeFeature | null | undefined {
  switch (attr) {
    case 'x-data':
    case 'x-props':
    case 'x-props-bind':
    case 'x-raw':
      return null
    case 'x-text':
    case 'x-show':
    case 'x-ref':
      return 'basics'
    case 'x-if':
    case 'x-for':
    case 'x-model':
    case 'x-html':
      return attr.slice(2) as RuntimeFeature
    case 'x-collection-root':
    case 'x-collection-item':
    case 'x-collection-use':
      return 'collection'
    default:
      return /^x-(bind|on)-/.test(attr) ? 'basics' : undefined
  }
}

/** The template with every jinja tag (`{{ … }}`, `{% … %}`, `{# … #}`) replaced by a space, string literals inside them
 * read as strings: a printed value such as shadcn's `has-[>svg]:px-3` (a folded class, F149) holds a `>` or a quote that
 * would otherwise end the element's tag early and hide the directives after it. A directive is never inside a jinja tag. */
export function withoutJinja(template: string): string {
  let out = ''
  let i = 0
  while (i < template.length) {
    const open = template.indexOf('{', i)
    const kind = open < 0 ? '' : template[open + 1]
    if (open < 0) {
      out += template.slice(i)
      break
    }
    if (kind !== '{' && kind !== '%' && kind !== '#') {
      out += template.slice(i, open + 1)
      i = open + 1
      continue
    }
    out += template.slice(i, open)
    const close = kind === '{' ? '}}' : `${kind}}`
    let j = open + 2
    let quote = ''
    for (; j < template.length; j++) {
      const ch = template[j]!
      if (quote) {
        if (ch === '\\') j++
        else if (ch === quote) quote = ''
      } else if (kind !== '#' && (ch === '"' || ch === "'")) quote = ch
      else if (template.startsWith(close, j)) break
    }
    out += ' '
    i = j + close.length
  }
  return out
}

/** The `x-*` attribute names on the elements of a template (tags only: prose that mentions `x-for` binds nothing). */
export function directiveAttrs(template: string): Set<string> {
  const out = new Set<string>()
  template = withoutJinja(template)
  for (const tag of template.matchAll(/<[a-zA-Z][\w-]*((?:[^>"']|"[^"]*"|'[^']*')*)>/g))
    for (const a of tag[1]!.matchAll(/(?:^|\s)(x-[a-z][a-z0-9-]*)(?==|\s|$|\/)/g)) out.add(a[1]!)
  return out
}

/**
 * The feature modules `template` needs, sorted in load order (`react` = the component is an island: `island`).
 * An `x-*` attribute no module binds is a build error (a compiler that learned a directive before the runtime did):
 * never a silent no-op in the browser.
 */
export function featuresOf(id: string, template: string, react: boolean): RuntimeFeature[] {
  const need = new Set<RuntimeFeature>()
  if (react) need.add('island')
  for (const attr of directiveAttrs(template)) {
    const f = featureOfAttr(attr)
    if (f === undefined) throw new BuildError('runtime-feature-missing', `${id}: the template uses ${attr}, which no client runtime feature binds`)
    if (f !== null) need.add(f)
  }
  return RUNTIME_FEATURES.filter((f) => need.has(f))
}

/** Matches the `/_brust/<file>` URL of `file` in a built chunk's text. */
const mentions = (text: string, file: string) => text.includes(`/_brust/${file}`)

/**
 * Whether the built client file `entry` (`client/<file>`) imports the store module `storeFile`, directly or through the
 * shared `chunk-*.js` files it imports. A component whose chunk does gets `store` in its features: the page preloads
 * the module (the chunk imports it itself, so it has no script tag).
 */
export function importsStore(read: (rel: string) => string | undefined, entry: string, storeFile: string, seen = new Set<string>()): boolean {
  if (seen.has(entry)) return false
  seen.add(entry)
  const text = read(entry)
  if (text === undefined) return false
  if (mentions(text, storeFile)) return true
  for (const m of text.matchAll(/(?:from|import)\s*"\.\/([^"]+\.js)"/g)) if (importsStore(read, `client/${m[1]}`, storeFile, seen)) return true
  return false
}
