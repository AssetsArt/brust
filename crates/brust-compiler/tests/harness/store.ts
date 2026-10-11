// Dual-evaluation stand-in for @brust/core/store (the real one lands with m3f-store-core): the same
// reactive core as the chunks (rt.ts), seeded from the sample's `__store` like the client registry
// seeds from <script data-brust-store> (D6).
import { computed, signal } from '../../../../packages/runtime-dom/src/index.ts'
export { computed, signal }
export function defineStore(name: string, factory: () => Record<string, any>) {
  const inst = factory()
  const seed = (globalThis as any).__BRUST_DUAL_STORE__?.[name] ?? {}
  for (const [k, v] of Object.entries(seed)) if (typeof inst[k]?.set === 'function') inst[k].set(v)
  return Object.defineProperty({ ...inst, snapshot: () => Object.fromEntries(Object.entries(inst).map(([k, x]) => [k, typeof x === 'function' && 'set' in x ? x() : x])) }, 'name', { value: name })
}
