// Server and later-wave plumbing; never documented, never aliased to the runtime URL.
export { __setServerResolver, applyStoreSnapshot } from './registry'
export type { ServerResolver, StoreInstanceRecord } from './registry'
export { hydrateRecord } from './define-store'
export { toScriptJson, storeScriptTag, parseStoreScript } from './serialize'
