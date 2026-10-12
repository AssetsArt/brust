import { onlyKeys } from './env'

export interface KvOptions { binding?: string; min_ttl_s?: number }
export interface DoOptions { binding?: string; store?: boolean }

const str = (v: unknown, what: string) => {
  if (typeof v !== 'string' || !v) throw new TypeError(`${what} must be a non-empty string`)
  return v
}

/** `kvAdapter({ binding, min_ttl_s })`. */
export function parseKv(o: KvOptions): { binding: string; minTtlS: number } {
  onlyKeys(o as Record<string, unknown>, ['binding', 'min_ttl_s'], [], 'cloudflare-kv')
  const minTtlS = o.min_ttl_s ?? 300
  if (typeof minTtlS !== 'number' || !Number.isInteger(minTtlS) || minTtlS < 0 || minTtlS > 31_536_000) throw new TypeError('cloudflare-kv: min_ttl_s must be an integer in 0..31536000')
  return { binding: o.binding === undefined ? 'BRUST_CACHE' : str(o.binding, 'cloudflare-kv: binding'), minTtlS }
}

/** `doAdapter({ binding, store })`. */
export function parseDo(o: DoOptions): { binding: string; store: boolean } {
  onlyKeys(o as Record<string, unknown>, ['binding', 'store'], [], 'cloudflare-do')
  if (o.store !== undefined && typeof o.store !== 'boolean') throw new TypeError('cloudflare-do: store must be a boolean')
  return { binding: o.binding === undefined ? 'BRUST_CACHE_DO' : str(o.binding, 'cloudflare-do: binding'), store: o.store ?? false }
}

/** The shared `[cache.cloudflare]` table (spec §6 keys) → each adapter's programmatic form; unknown keys are TypeErrors. */
const TABLE = ['kv_binding', 'kv_min_ttl_s', 'do_binding', 'do_store']
export function fromTable(t: Record<string, unknown>, what: string): { kv: KvOptions; do: DoOptions } {
  onlyKeys(t, TABLE, [], what)
  return {
    kv: { ...(t.kv_binding !== undefined ? { binding: t.kv_binding as string } : {}), ...(t.kv_min_ttl_s !== undefined ? { min_ttl_s: t.kv_min_ttl_s as number } : {}) },
    do: { ...(t.do_binding !== undefined ? { binding: t.do_binding as string } : {}), ...(t.do_store !== undefined ? { store: t.do_store as boolean } : {}) },
  }
}
