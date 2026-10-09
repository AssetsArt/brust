// Runtime shim for the dual-evaluation harness: the generated chunks import
// from here; defineBehavior records the factory instead of mounting.
export { signal, computed, effect, batch, untracked } from '../../../../packages/runtime-dom/src/index.ts'

export const captured = new Map<string, (ctx: unknown) => Record<string, unknown> | void>()

export function defineBehavior(name: string, factory: (ctx: unknown) => Record<string, unknown> | void) {
  captured.set(name, factory)
  return factory
}
