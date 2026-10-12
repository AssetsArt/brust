// A Worker that exposes the cache adapters over HTTP, so the Bun-side conformance suite drives them under local workerd.
import { env } from 'cloudflare:workers'
import { combine } from '../../../packages/cache-cloudflare/src/combine'
import { doAdapter } from '../../../packages/cache-cloudflare/src/do-adapter'
import { kvAdapter } from '../../../packages/cache-cloudflare/src/kv-adapter'

export { BrustCacheDO } from '../../../packages/cache-cloudflare/src/do-class'

type Kind = 'kv' | 'do' | 'kvdo'
const adapters = new Map<string, any>()
const b64 = (u: Uint8Array) => {
  let s = ''
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000))
  return btoa(s)
}
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

function adapterFor(kind: Kind, ns: string) {
  const k = `${kind}:${ns}`
  let a = adapters.get(k)
  if (!a) {
    a = kind === 'kv' ? kvAdapter({ min_ttl_s: 0 }) : kind === 'do' ? doAdapter({ store: true }) : doAdapter({}).composeWith(kvAdapter({ min_ttl_s: 0 }))
    adapters.set(k, a)
  }
  return a
}

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    try {
      const body = (await req.json()) as any
      if (url.pathname === '/hook') {
        // DO test hooks (BRUST_CACHE_TEST=1 is set in this config only)
        const ns = (env as any).BRUST_CACHE_DO
        const stub = ns.getByName(body.target === 'epoch' ? `epoch:${body.ns}` : `store:${body.ns}:${body.i}`)
        return Response.json((await stub[body.name]()) ?? null)
      }
      if (url.pathname !== '/call') return new Response('not found', { status: 404 })
      const a = adapterFor(body.kind, body.ns)
      const t = body.target === 'broadcast' ? a.broadcast : body.target === 'store' ? a.store : a
      const args = body.args
      let out: unknown
      switch (body.op) {
        case 'init':
          out = await a.init?.(args[0])
          break
        case 'close':
          out = await a.close?.()
          break
        case 'get': {
          const r = await t.get(args[0])
          out = { ...r, page: r.page ? { status: r.page.status, headers: r.page.headers, body: b64(r.page.body) } : null }
          break
        }
        case 'set':
          out = await t.set(args[0], { ...args[1], body: unb64(args[1].body) }, args[2])
          break
        default:
          out = await t[body.op](...args)
      }
      return Response.json(out === undefined ? null : out)
    } catch (e) {
      return new Response(String((e as Error)?.stack ?? e), { status: 500 })
    }
  },
}
