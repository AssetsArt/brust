import { createAdapter, type RedisAdapter } from './adapter'

export type { RedisAdapter, RedisAdapterTest } from './adapter'
export type { RedisCacheOptions } from './options'

/** `[cache] adapter = "redis"`: the factory brust calls with `[cache.redis]` (after `env:` resolution). */
export function redisAdapter(options: Record<string, unknown>): RedisAdapter {
  return createAdapter('redis', options)
}

export default redisAdapter
