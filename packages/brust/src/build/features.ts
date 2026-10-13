// Which client-runtime feature modules a component needs (L33, R35.2). The compiler's output is the source of truth:
// a native component's template carries one `x-*` attribute per directive it uses, a react-tier component is an island.
// The set is written per component into the manifest; the server unions it over a route's components and links the
// core plus exactly those modules. `packages/runtime-dom/README.md` ("Feature modules") owns the module list and the rule.
import { BuildError } from './errors'

/** Feature modules of `@brust/runtime-dom/features/*` the browser build ships, in load order. */
export const RUNTIME_FEATURES = ['basics', 'if', 'for', 'model', 'html', 'island'] as const
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
    default:
      return /^x-(bind|on)-/.test(attr) ? 'basics' : undefined
  }
}

/** The `x-*` attribute names on the elements of a template (tags only: prose that mentions `x-for` binds nothing). */
export function directiveAttrs(template: string): Set<string> {
  const out = new Set<string>()
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
