import { createAdapter, type RedisAdapter } from './adapter'

export type { RedisAdapter, RedisAdapterTest } from './adapter'
export type { RedisCacheOptions } from './options'

/** `[cache] adapter = "dragonfly"`: the same code as Redis (every script declares all its keys). */
export function dragonflyAdapter(options: Record<string, unknown>): RedisAdapter {
  return createAdapter('dragonfly', options)
}

export default dragonflyAdapter
