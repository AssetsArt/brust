# @brust/cache-redis

The Redis and Dragonfly cache adapter for brust (`[cache] adapter = "redis"` or `"dragonfly"`).
Built on Bun's `RedisClient`: no npm dependency, Bun only (not Cloudflare Workers).

Configure it in `brust.toml` (`[cache]` + `[cache.redis]`, the URL always via `env:NAME`); see the brust docs, "Redis / Dragonfly".
