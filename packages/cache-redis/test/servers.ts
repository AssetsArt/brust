// Test plumbing for the env-gated suites: which servers run, namespaced adapters, and cleanup that
// only ever touches the namespaces a test made (never FLUSHDB: the servers may be shared).
import { RedisClient } from 'bun'
import { createAdapter, type RedisAdapter } from '../src/adapter'

export type Flavor = 'redis' | 'dragonfly'

export function servers(): [Flavor, string][] {
  const want: [Flavor, string, string][] = [
    ['redis', 'BRUST_REDIS_URL', process.env.BRUST_REDIS_URL ?? ''],
    ['dragonfly', 'BRUST_DRAGONFLY_URL', process.env.BRUST_DRAGONFLY_URL ?? ''],
  ]
  const missing = want.filter((w) => !w[2]).map((w) => w[1])
  if (missing.length && process.env.BRUST_REDIS_REQUIRED === '1') throw new Error(`BRUST_REDIS_REQUIRED=1 but ${missing.join(' and ')} not set`)
  return want.filter((w) => w[2]).map((w) => [w[0], w[2]])
}

const made = new Map<string, Set<string>>() // url -> namespaces
const open: RedisAdapter[] = []

export const ns = () => `t-${crypto.randomUUID()}`

export async function make(flavor: Flavor, url: string, extra: Record<string, unknown> = {}, namespace = ns(), init = true): Promise<RedisAdapter> {
  const a = createAdapter(flavor, { url, ...extra })
  if (!made.has(url)) made.set(url, new Set())
  made.get(url)!.add(namespace)
  if (init) await a.init!({ namespace, buildId: 'b1', runtime: 'bun', workerId: 0 })
  open.push(a)
  return a
}

/** An adapter for a URL that is expected to be dead: not tracked for the SCAN sweep. */
export async function makeOffline(url: string, extra: Record<string, unknown> = {}): Promise<RedisAdapter> {
  const a = createAdapter('redis', { url, ...extra })
  await a.init!({ namespace: ns(), buildId: 'b1', runtime: 'bun', workerId: 0 })
  open.push(a)
  return a
}

export async function sweep(): Promise<void> {
  await Promise.allSettled(open.splice(0).map((a) => a.close?.()))
  for (const [url, spaces] of made) {
    const c = new RedisClient(url)
    try {
      for (const n of spaces) {
        let cursor = '0'
        do {
          const [next, ks] = (await c.send('SCAN', [cursor, 'MATCH', `{brust:${n}}:*`, 'COUNT', '500'])) as [string, string[]]
          cursor = next
          if (ks.length) await c.unlink(...ks)
        } while (cursor !== '0')
      }
    } finally {
      c.close()
    }
  }
  made.clear()
}

export const enc = new TextEncoder()
export const html = (body: string | Uint8Array, headers: [string, string][] = [['content-type', 'text/html']]) => ({
  status: 200,
  headers,
  body: typeof body === 'string' ? enc.encode(body) : body,
})
export const meta = (o: Partial<import('@brust/core/cache-adapter').SetMeta> = {}) => ({ ttlMs: 60_000, tags: [] as string[], method: 'GET', path: '/', stamp: null as number | null, ...o })
