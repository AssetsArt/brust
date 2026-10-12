import type { CacheAdapterFactory } from '@brust/core/cache-adapter'
import { fromTable } from './options'
import { type KvAdapter, kvAdapter } from './kv-adapter'

export { type KvAdapter, kvAdapter }
export type { KvOptions } from './options'

/** The `[cache.cloudflare]` table (`kv_binding`, `kv_min_ttl_s`) → the adapter. */
const factory: CacheAdapterFactory = (table) => kvAdapter(fromTable(table, 'cloudflare-kv').kv)
export default factory
