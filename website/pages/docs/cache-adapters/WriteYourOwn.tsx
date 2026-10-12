// Write your own cache adapter — port of docs/cache-adapters.md section 4 (v2, reviewed). The example sketch was
// type-checked against @brust/core/cache-adapter; it is not run against a live service.
import CodeBlock from '../../../components/CodeBlock'
import Note from '../../../components/docs/Note'
import Step from '../../../components/docs/Step'
import { type CodeBlockData, type CodeBlockInput, codeBlock } from '../../../lib/highlight'
import type { TocItem } from '../../../lib/nav'

const SRC = {
  adapter: {
    lang: 'ts',
    file: '@brust/core/cache-adapter',
    code: `export interface CacheAdapter {
  readonly name: string
  readonly runtimes: ReadonlyArray<'bun' | 'workers'>
  store?: CacheStore
  broadcast?: CacheBroadcast
  init?(ctx: { namespace: string; buildId: string; runtime: 'bun' | 'workers'; workerId: number }): Promise<void>
  close?(): Promise<void>
}`,
  },
  store: {
    lang: 'ts',
    file: '@brust/core/cache-adapter',
    code: `interface CacheStore {
  get(key: string): Promise<{ page: StoredPage | null; stamp: number | null; entryStamp: number | null; storedAt: number | null }>
  set(key: string, page: StoredPage, meta: { ttlMs: number; tags: string[]; method: string; path: string; stamp: number | null }): Promise<boolean>
  invalidate(args: InvalidateArgs): Promise<void>
  readonly maxBodyBytes: number
}
interface StoredPage { status: number; headers: [string, string][]; body: Uint8Array }   // identity body`,
  },
  broadcast: {
    lang: 'ts',
    file: '@brust/core/cache-adapter',
    code: `interface CacheBroadcast {
  publish(args: InvalidateArgs, origin: string): Promise<number>   // resolves to the sequence number assigned
  subscribe?(on: (e: InvalidationEvent) => void, onGap: () => void): Promise<() => Promise<void>>   // push (native)
  since?(seq: number): Promise<{ gen: string; seq: number; behind: boolean; events: InvalidationEvent[] }>   // pull (Workers)
}
interface InvalidationEvent { seq: number; origin: string; args: InvalidateArgs }`,
  },
  example: {
    lang: 'ts',
    file: 'lib/cache.ts',
    code: `import { defineCacheAdapter, type StoredPage } from '@brust/core/cache-adapter'

// Chunked, so a large page body does not overflow the argument limit of String.fromCharCode.
const toBase64 = (bytes: Uint8Array): string => {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

export default defineCacheAdapter((opts) => {
  const base = String(opts.baseUrl)
  const token = String(opts.token)
  const call = (path: string, init: RequestInit = {}) =>
    fetch(base + path, { ...init, headers: { authorization: \`Bearer \${token}\`, ...init.headers } })
  return {
    name: 'http-kv',
    runtimes: ['bun', 'workers'],
    store: {
      maxBodyBytes: 1_048_576,
      async get(key) {
        const r = await call(\`/get/\${encodeURIComponent(key)}\`)
        if (r.status === 404) return { page: null, stamp: null, entryStamp: null, storedAt: null }
        const j = (await r.json()) as { status: number; headers: [string, string][]; body: string; storedAt: number }
        const page: StoredPage = { status: j.status, headers: j.headers, body: Uint8Array.from(atob(j.body), (c) => c.charCodeAt(0)) }
        return { page, stamp: null, entryStamp: null, storedAt: j.storedAt }
      },
      async set(key, page, meta) {
        const r = await call(\`/set/\${encodeURIComponent(key)}?ttl=\${Math.ceil(meta.ttlMs / 1000)}\`, {
          method: 'POST',
          body: JSON.stringify({ status: page.status, headers: page.headers, body: toBase64(page.body), storedAt: Date.now() }),
        })
        return r.ok
      },
      async invalidate() {
        // A service with no tag index cannot delete by tag. Entries then expire by their TTL.
      },
    },
  }
})`,
  },
  config: {
    lang: 'toml',
    file: 'brust.toml',
    code: `[cache]
adapter = "custom"
module = "lib/cache.ts"

[cache.options]
baseUrl = "https://kv.example.com"
token = "set in the environment and read there, not written in brust.toml"`,
  },
  conformance: {
    lang: 'ts',
    file: 'test/cache.test.ts',
    code: `import { runConformance } from '@brust/core/cache-adapter/conformance'
// bun:test cases: binary-safe bodies, header order, TTL expiry, tag and path invalidation,
// the stale-write guard, push/pull delivery, gaps. Pass the capabilities your adapter claims.
runConformance(() => myAdapter(), { push: true, guard: true })`,
  },
} satisfies Record<string, CodeBlockInput>

export interface WriteYourOwnData {
  toc: TocItem[]
  blocks: Record<keyof typeof SRC, CodeBlockData>
}

export async function writeYourOwnLoader(): Promise<WriteYourOwnData> {
  return {
    toc: [
      { id: 'shape', title: 'The adapter shape' },
      { id: 'store', title: 'Store' },
      { id: 'broadcast', title: 'Broadcast' },
      { id: 'example', title: 'A minimal adapter' },
      { id: 'test', title: 'Test it' },
    ],
    blocks: Object.fromEntries(Object.entries(SRC).map(([k, v]) => [k, codeBlock(v)])) as WriteYourOwnData['blocks'],
  }
}

export default function WriteYourOwn({ blocks }: WriteYourOwnData) {
  return (
    <section style={{ display: 'contents' }}>
      <h1>Write your own</h1>
      <p className="lead">
        An adapter is a plain object with a <code>store</code>, a <code>broadcast</code>, or both. Import the types from <code>@brust/core/cache-adapter</code>.
      </p>
      <p>
        That module has no <code>bun</code> import, so it bundles into a Worker. Set <code>adapter = &quot;custom&quot;</code> and <code>module = &quot;lib/cache.ts&quot;</code> in <code>[cache]</code> (see the <a href="/docs/cache-adapters/overview">overview</a>).
      </p>

      <Step n={1} id="shape" title="The adapter shape" />
      <CodeBlock code={blocks.adapter.code} lang={blocks.adapter.lang} file={blocks.adapter.file} html={blocks.adapter.html} />
      <p>An adapter needs a store, a broadcast, or both.</p>

      <Step n={2} id="store" title="Store: shared page bodies" />
      <CodeBlock code={blocks.store.code} lang={blocks.store.lang} file={blocks.store.file} html={blocks.store.html} />
      <ul>
        <li>
          <code>get</code> returns the page or <code>null</code>. <code>stamp</code> is the broadcast sequence number <i>now</i>; <code>set</code> later passes it back as <code>meta.stamp</code>.
        </li>
        <li>
          <code>set</code> returns <code>false</code> to refuse a write. A store that can do atomic writes <b>must</b> refuse when <code>meta.stamp</code> is older than an invalidation of one of <code>meta.tags</code> or of <code>meta.method meta.path</code>. This stops a page rendered before an invalidation from being stored after it. A store that cannot (a plain key-value service) returns <code>null</code> stamps and its writes are unguarded: stale entries then live up to their TTL.
        </li>
        <li>
          <code>invalidate</code> deletes by tag or by path. It ignores <code>key</code>. Record the invalidation <i>before</i> deleting, so a racing stale <code>set</code> is refused even before the broadcast.
        </li>
        <li>Bodies are binary. Preserve every byte value, and the order and repeats of headers.</li>
      </ul>

      <Step n={3} id="broadcast" title="Broadcast: invalidation events" />
      <p>
        Provide exactly one of <code>subscribe</code> or <code>since</code>:
      </p>
      <CodeBlock code={blocks.broadcast.code} lang={blocks.broadcast.lang} file={blocks.broadcast.file} html={blocks.broadcast.html} />
      <ul>
        <li>
          Every <code>stamp</code>, <code>entryStamp</code> and event <code>seq</code> is a number in <b>one</b> sequence space, the broadcast&rsquo;s.
        </li>
        <li>
          Push: call <code>on</code> in order, and call <code>onGap</code> whenever delivery may have lost an event; brust then clears tier 1.
        </li>
        <li>
          Pull: <code>gen</code> identifies the broadcast&rsquo;s history. If it changes, or <code>behind</code> is true, brust clears tier 1.
        </li>
        <li>
          brust skips events whose <code>origin</code> is its own: it already cleared its tier 1.
        </li>
      </ul>

      <Step n={4} id="example" title="A minimal adapter" />
      <p>A store-only adapter over an HTTP key-value service. It works on both runtimes, has no broadcast, and so does not guard writes:</p>
      <CodeBlock code={blocks.example.code} lang={blocks.example.lang} file={blocks.example.file} html={blocks.example.html} />
      <CodeBlock code={blocks.config.code} lang={blocks.config.lang} file={blocks.config.file} html={blocks.config.html} />
      <Note>
        This sketch skips error handling: a thrown error is counted and treated as a miss. It is a shape to copy from, not a tested client for any particular service.
      </Note>

      <Step n={5} id="test" title="Test it" />
      <p>Test your adapter with the conformance suite brust uses for its own adapters:</p>
      <CodeBlock code={blocks.conformance.code} lang={blocks.conformance.lang} file={blocks.conformance.file} html={blocks.conformance.html} />
      <p>
        <code>@brust/core/cache-adapter</code> also exports <code>memoryAdapter</code>, the reference implementation. It shares nothing across processes, so it is for tests, not production.
      </p>
    </section>
  )
}
