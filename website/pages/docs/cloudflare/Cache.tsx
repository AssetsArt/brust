// Cache on KV and DO — port of docs/cloudflare.md section 7 (caching on Workers), plus the pointer to the adapter
// pages that make invalidation reach every isolate (docs/cache-adapters.md, v2, reviewed).
import CodeBlock from '../../../components/CodeBlock'
import Note from '../../../components/docs/Note'
import { type CodeBlockData, type CodeBlockInput, codeBlock } from '../../../lib/highlight'
import type { TocItem } from '../../../lib/nav'
import Lead from '../../../components/docs/Lead'

const SRC = {
  route: {
    lang: 'tsx',
    file: 'routes.tsx',
    code: `{ path: '/pokemon/{name}', Component: DetailPage, loader: detailLoader,
  cache: { ttl_seconds: 60, tags: ['pokemon', 'team'] } },`,
  },
  pair: {
    lang: 'toml',
    file: 'brust.toml',
    code: `[cache]
adapter = "cloudflare-kv"
broadcast = "cloudflare-do"
epoch_interval_ms = 5000

[cache.cloudflare]
kv_min_ttl_s = 300`,
  },
} satisfies Record<string, CodeBlockInput>

export interface CloudflareCacheData {
  toc: TocItem[]
  blocks: Record<keyof typeof SRC, CodeBlockData>
}

export async function cloudflareCacheLoader(): Promise<CloudflareCacheData> {
  return {
    toc: [
      { id: 'tiers', title: 'Two tiers' },
      { id: 'isolates', title: 'Isolates and invalidation' },
      { id: 'adapter', title: 'Reaching every isolate' },
      { id: 'rules', title: 'Rules that stay the same' },
    ],
    blocks: Object.fromEntries(Object.entries(SRC).map(([k, v]) => [k, codeBlock(v)])) as CloudflareCacheData['blocks'],
  }
}

export default function CloudflareCache({ blocks }: CloudflareCacheData) {
  return (
    <>
      <h1>Cache on KV and DO</h1>
      <Lead>
        On Workers every isolate has its own page cache. This page explains what that means for <code>cache.invalidate</code> and when to add a shared tier.
      </Lead>

      <h2 id="tiers">Two tiers</h2>
      <p>
        There are two cache tiers. <b>Tier 1</b> is the per-isolate memory cache inside the wasm: pages (<code>l1_capacity</code>) and job results (<code>job_cache_capacity</code>). <b>Tier 2</b> is an optional shared store you add with a cache adapter (<a href="/docs/cache-adapters/overview">Cache adapters</a>).
      </p>
      <CodeBlock code={blocks.route.code} lang={blocks.route.lang} file={blocks.route.file} html={blocks.route.html} />

      <h2 id="isolates">Isolates and invalidation</h2>
      <p>An isolate is one running copy of your Worker. Cloudflare starts and recycles many of them, in many locations, at will. Each has its own tier 1. So:</p>
      <ul>
        <li>A page rendered in one isolate is not a hit in another. The hit rate is lower than on native.</li>
        <li>
          <b>
            <code>cache.invalidate</code> is isolate-local without an adapter.
          </b>{' '}
          The isolate that ran the action drops its entries at once. Every other isolate keeps serving the old page until its route <code>ttl_seconds</code> runs out. Keep <code>ttl_seconds</code> short on Workers if you do not configure an adapter.
        </li>
      </ul>
      <Note tag="Default">
        With no <code>[cache]</code> table, nothing is shared: a page that stays stale after a mutation is expected, for at most <code>ttl_seconds</code>.
      </Note>

      <h2 id="adapter">Reaching every isolate</h2>
      <p>
        To make a mutation visible everywhere within about <code>epoch_interval_ms</code> (default 1 s), configure a cache adapter with a broadcast. The Durable Object adapter does this. The recommended pair keeps page bodies in KV and carries invalidations through a Durable Object:
      </p>
      <CodeBlock code={blocks.pair.code} lang={blocks.pair.lang} file={blocks.pair.file} html={blocks.pair.html} />
      <p>
        Bindings, options, what each configuration guarantees and the Free-plan cost of polling are on <a href="/docs/cache-adapters/cloudflare">Cache adapters: Cloudflare</a>. The shared contract is on the <a href="/docs/cache-adapters/overview">overview</a>.
      </p>

      <h2 id="rules">Rules that stay the same</h2>
      <ul>
        <li>
          Within one isolate the stamp rules are the native ones: a page whose render started before an invalidation is not stored.
        </li>
        <li>
          <code>Date.now()</code> on Workers advances only across I/O, so TTLs are coarse inside a single request. That is harmless.
        </li>
        <li>
          A page with <code>Set-Cookie</code> is not cached, as on native.
        </li>
      </ul>
    </>
  )
}
