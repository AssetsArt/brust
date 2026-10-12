// The two scripts (cache-redis R4, R6). The text is exact: the reviewer diffs it against the plan.
// Every key a script touches is declared in KEYS (Dragonfly needs it; cluster needs one slot).
import type { RedisClient } from 'bun'

// SET_LUA  KEYS = [stage, page, idx_1..idx_n, mark_1..mark_n]  ARGV = [stamp|"", ttl_ms, n]
export const SET_LUA = `local n = tonumber(ARGV[3]); local ttl = tonumber(ARGV[2])
if ARGV[1] ~= '' then
  local stamp = tonumber(ARGV[1])
  for i = 1, n do
    local m = redis.call('GET', KEYS[2 + n + i])
    if m and tonumber(m) > stamp then redis.call('DEL', KEYS[1]); return 0 end
  end
end
if redis.call('EXISTS', KEYS[1]) == 0 then return -1 end
redis.call('RENAME', KEYS[1], KEYS[2]); redis.call('PEXPIRE', KEYS[2], ttl)
for i = 1, n do
  redis.call('SADD', KEYS[2 + i], KEYS[2])
  local t = redis.call('PTTL', KEYS[2 + i])
  if t == -1 or (t >= 0 and t < ttl) then redis.call('PEXPIRE', KEYS[2 + i], ttl) end
end
return 1`

// INVAL_LUA  KEYS = [seq, idx_1..idx_n, mark_1..mark_n]  ARGV = [mode ('both'|'delete'|'publish'), n, marker_ttl_ms]
export const INVAL_LUA = `local unpack = table.unpack or unpack  -- Lua 5.1 (Redis) and 5.4 (Dragonfly)
local mode = ARGV[1]; local n = tonumber(ARGV[2]); local mttl = tonumber(ARGV[3])
local v
if mode == 'delete' then v = tonumber(redis.call('GET', KEYS[1]) or '0') + 1 else v = redis.call('INCR', KEYS[1]) end
for i = 1, n do
  local k = KEYS[1 + n + i]; local c = tonumber(redis.call('GET', k) or '0')
  if v > c then redis.call('SET', k, v, 'PX', mttl) else redis.call('PEXPIRE', k, mttl) end
end
local out = { mode == 'delete' and v - 1 or v }
if mode ~= 'publish' and n > 0 then
  local idx = {}; for i = 1, n do idx[i] = KEYS[1 + i] end
  for _, m in ipairs(redis.call('SUNION', unpack(idx))) do out[#out + 1] = m end
  redis.call('DEL', unpack(idx))
end
return out`

const sha1 = (s: string) => new Bun.CryptoHasher('sha1').update(s).digest('hex')

export interface Script {
  readonly source: string
  readonly sha: string
}

export const SET_SCRIPT: Script = { source: SET_LUA, sha: sha1(SET_LUA) }
export const INVAL_SCRIPT: Script = { source: INVAL_LUA, sha: sha1(INVAL_LUA) }

/** EVALSHA; a NOSCRIPT reply (restart, failover, SCRIPT FLUSH) → EVAL, which also caches it. */
export async function evalsha(c: RedisClient, s: Script, keys: string[], argv: (string | number)[]): Promise<unknown> {
  const tail = [String(keys.length), ...keys, ...argv.map(String)]
  try {
    return await c.send('EVALSHA', [s.sha, ...tail])
  } catch (e) {
    if (!/NOSCRIPT/.test(e instanceof Error ? e.message : String(e))) throw e
    return await c.send('EVAL', [s.source, ...tail])
  }
}
