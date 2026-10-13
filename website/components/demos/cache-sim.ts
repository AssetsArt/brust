// The Caching page's probe, simulated (plan R6): this site is a static export, so no server sends x-brust-cache.
// This models the demo route's real rules (routes.tsx: ttl_seconds 60, tags ['pokemon'], bypass 'query(nocache)')
// and the L1 rules the page documents: the key is method + path + sorted query, GET and HEAD share entries, only a
// 200 is stored, a repeated query name is ambiguous and bypasses. It reports the header a real server would send;
// it measures nothing, so it prints no timings.
import { byName } from '../../lib/pokemon'

export const DEMO_TTL_SECONDS = 60
const ROUTE = /^\/demo\/pokemon\/([^/]+)$/

export interface SimResponse {
  status: 200 | 404
  cache: 'MISS' | 'HIT' | 'BYPASS'
}

export function createCacheSim(now: () => number = Date.now) {
  const stored = new Map<string, number>()
  return {
    get(url: string, method: 'GET' | 'HEAD' = 'GET'): SimResponse {
      const u = new URL(url, 'http://sim')
      const m = ROUTE.exec(u.pathname)
      const status = m && byName(decodeURIComponent(m[1]!)) ? 200 : 404
      const names = [...u.searchParams.keys()]
      if ((u.searchParams.get('nocache') ?? '') !== '' || new Set(names).size !== names.length) return { status, cache: 'BYPASS' }
      const query = [...u.searchParams].map(([k, v]) => `${k}=${v}`).sort().join('&')
      const key = `${method === 'HEAD' ? 'GET' : method} ${u.pathname}?${query}`
      const at = stored.get(key)
      if (at !== undefined && now() - at < DEMO_TTL_SECONDS * 1000) return { status, cache: 'HIT' }
      if (status === 200) stored.set(key, now())
      else stored.delete(key)
      return { status, cache: 'MISS' }
    },
  }
}

/** The page's one simulated server. */
export const demoCache = createCacheSim()
