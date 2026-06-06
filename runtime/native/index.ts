// brustjs/native — directive runtime registration surface. React-free, dom-only.
// Authors do NOT import the runtime FUNCTIONS directly; the build-generated
// _directives.js entry does. The TYPES below ARE for authors — annotate a
// `behavior`'s ctx (e.g. `({ effect }: BehaviorCtx) => …`).
export { register, start } from './runtime.ts'
export type { Behavior, BehaviorCtx, Instance } from './runtime.ts'
