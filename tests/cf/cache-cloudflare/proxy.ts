// A CacheAdapter whose every method is an HTTP call into the harness Worker (so runConformance can run against workerd).
import type { CacheAdapter, CacheAdapterInit, CacheBroadcast, CacheStore } from '@brust/core/cache-adapter'

export type Kind = 'kv' | 'do' | 'kvdo'
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64')
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'))

export async function call<T>(base: string, kind: Kind, ns: string, target: 'store' | 'broadcast' | 'adapter', op: string, ...args: unknown[]): Promise<T> {
  const r = await fetch(`${base}/call`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, ns, target, op, args }) })
  if (!r.ok) throw new Error(`harness ${kind}.${target}.${op} -> ${r.status}: ${await r.text()}`)
  return (await r.json()) as T
}
export async function hook(base: string, target: 'epoch' | 'shard', ns: string, name: string, i = 0): Promise<any> {
  const r = await fetch(`${base}/hook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target, ns, i, name }) })
  if (!r.ok) throw new Error(`harness hook ${name} -> ${r.status}: ${await r.text()}`)
  return r.json()
}

export function proxyAdapter(base: string, kind: Kind, ns: string): CacheAdapter {
  const c = <T>(target: 'store' | 'broadcast' | 'adapter', op: string, ...args: unknown[]) => call<T>(base, kind, ns, target, op, ...args)
  const store: CacheStore = {
    maxBodyBytes: kind === 'do' ? 1_900_000 : 8 * 1024 * 1024,
    async get(key) {
      const r = await c<any>('store', 'get', key)
      return { ...r, page: r.page ? { ...r.page, body: unb64(r.page.body) } : null }
    },
    set: (key, page, meta) => c<boolean>('store', 'set', key, { ...page, body: b64(page.body) }, meta),
    invalidate: (args) => c<void>('store', 'invalidate', args),
  }
  const broadcast: CacheBroadcast = {
    publish: (args, origin) => c<number>('broadcast', 'publish', args, origin),
    since: (seq) => c('broadcast', 'since', seq),
  }
  return {
    name: `proxy-${kind}`,
    runtimes: ['workers'],
    store,
    ...(kind === 'kv' ? {} : { broadcast }),
    // The suite initialises every adapter with the same namespace; a unique one per adapter keeps cases independent.
    init: async (ctx: CacheAdapterInit) => {
      await c('adapter', 'init', { ...ctx, namespace: ns })
    },
    close: async () => {},
  }
}
