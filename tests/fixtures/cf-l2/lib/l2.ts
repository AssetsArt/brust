// One memory adapter per isolate, shared by the cache module and the e2e actions (pull broadcast).
import { memoryAdapter } from '@brust/core/cache-adapter'

export const L2 = memoryAdapter({ broadcast: 'pull' })
