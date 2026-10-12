// `[cache.redis]` (cache-redis R10, R11): validated at worker boot; the same key list is checked at
// `brust build` by `parseCache`. Errors name the key and never echo the url (it may hold a password).
import { readFileSync } from 'node:fs'

export const OPTION_KEYS = ['url', 'tls', 'connect_timeout_ms', 'max_body_bytes', 'marker_ttl_ms', 'unlink_batch', 'reconnect_min_ms', 'reconnect_max_ms'] as const

export interface RedisCacheOptions {
  url: string
  tls?: boolean | { reject_unauthorized?: boolean; server_name?: string; ca_file?: string }
  connect_timeout_ms?: number
  max_body_bytes?: number
  marker_ttl_ms?: number
  unlink_batch?: number
  reconnect_min_ms?: number
  reconnect_max_ms?: number
}

export interface ResolvedOptions {
  url: string
  tls: boolean | Bun.TLSOptions
  connectTimeoutMs: number
  maxBodyBytes: number
  markerTtlMs: number
  unlinkBatch: number
  reconnectMinMs: number
  reconnectMaxMs: number
}

const bad = (m: string): never => {
  throw new TypeError(`cache-redis: ${m}`)
}

function int(o: Record<string, unknown>, k: string, min: number, max: number, dflt: number): number {
  const v = o[k]
  if (v === undefined) return dflt
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) return bad(`${k} must be an integer in ${min}..${max} (got ${JSON.stringify(v)})`)
  return v
}

function tlsOf(v: unknown): boolean | Bun.TLSOptions {
  if (v === undefined || typeof v === 'boolean') return v ?? false
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return bad('tls must be true, false or a table')
  const t = v as Record<string, unknown>
  for (const k of Object.keys(t)) if (k !== 'reject_unauthorized' && k !== 'server_name' && k !== 'ca_file') bad(`unknown option "tls.${k}"`)
  const out: Bun.TLSOptions = {}
  if (t.reject_unauthorized !== undefined) {
    if (typeof t.reject_unauthorized !== 'boolean') bad('tls.reject_unauthorized must be a boolean')
    out.rejectUnauthorized = t.reject_unauthorized as boolean
  }
  if (t.server_name !== undefined) {
    if (typeof t.server_name !== 'string' || t.server_name === '') bad('tls.server_name must be a non-empty string')
    out.serverName = t.server_name as string
  }
  if (t.ca_file !== undefined) {
    if (typeof t.ca_file !== 'string' || t.ca_file === '') bad('tls.ca_file must be a non-empty path')
    try {
      out.ca = readFileSync(t.ca_file as string, 'utf8')
    } catch {
      bad('tls.ca_file cannot be read')
    }
  }
  return out
}

export function parseOptions(raw: Record<string, unknown>): ResolvedOptions {
  for (const k of Object.keys(raw)) if (!(OPTION_KEYS as readonly string[]).includes(k)) bad(`unknown option "${k}"`)
  const url = raw.url
  if (typeof url !== 'string' || url.trim() === '') bad('url is required (set it as "env:NAME" in [cache.redis])')
  const reconnectMinMs = int(raw, 'reconnect_min_ms', 10, 60_000, 100)
  const reconnectMaxMs = int(raw, 'reconnect_max_ms', 10, 600_000, Math.max(5000, reconnectMinMs))
  if (reconnectMaxMs < reconnectMinMs) bad('reconnect_max_ms must be >= reconnect_min_ms')
  return {
    url: (url as string).trim(),
    tls: tlsOf(raw.tls),
    connectTimeoutMs: int(raw, 'connect_timeout_ms', 100, 60_000, 2000),
    maxBodyBytes: int(raw, 'max_body_bytes', 1, 67_108_864, 1_048_576),
    markerTtlMs: int(raw, 'marker_ttl_ms', 60_000, 604_800_000, 86_400_000),
    unlinkBatch: int(raw, 'unlink_batch', 1, 10_000, 500),
    reconnectMinMs,
    reconnectMaxMs,
  }
}
