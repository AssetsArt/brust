// What a feature module may import from the core, and nothing else. In the browser build the core is one shared
// ESM file and every feature is a separate file that imports these names from it (bundle.ts maps this module to the
// core URL), so a feature registers on the page's single binder registry and signal graph.
export { BINDERS, bindHost, bindElement, walkChildren } from './directives/index'
export type { Binder } from './directives/index'
export { parsed, read, member, mismatch, insideRaw, RAW_SEL } from './directives/common'
export { hooks, islandHooks } from './instance'
export { warnOnce } from './warn'
export { signal, computed, isSignal } from './signal'
export type { Signal } from './signal'
