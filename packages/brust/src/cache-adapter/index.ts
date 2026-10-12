// `@brust/core/cache-adapter`: the contract, the in-memory adapter and `defineCacheAdapter`.
// No `bun`/`bun:*` import here (the Cloudflare bundle imports it); the conformance suite is its own
// subpath, `@brust/core/cache-adapter/conformance`.
import type { CacheAdapter, CacheAdapterFactory } from './types'

export type * from './types'
export { type MemoryAdapter, type MemoryAdapterOptions, type MemoryAdapterTest, memoryAdapter } from './memory'

/** Identity, for type inference: `export default defineCacheAdapter((opts) => ({ … }))`. */
export const defineCacheAdapter = <T extends CacheAdapter | CacheAdapterFactory>(a: T): T => a
