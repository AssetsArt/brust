// Cloudflare KV and Durable Objects adapter — port of docs/cache-adapters.md sections 6 and 9 and sources C7-C10
// (v2, reviewed). Cloudflare figures were read on 2026-10-12.
import CodeBlock from '../../../components/CodeBlock'
import Note from '../../../components/docs/Note'
import { type CodeBlockData, type CodeBlockInput, codeBlock } from '../../../lib/highlight'
import type { TocItem } from '../../../lib/nav'
import Lead from '../../../components/docs/Lead'
import TableWrap from '../../../components/docs/TableWrap'

const SRC = {
  install: { lang: 'sh', cwd: '~/my-app', code: '$ bun add @brust/cache-cloudflare' },
  toml: {
    lang: 'toml',
    file: 'brust.toml',
    code: `[cache]
adapter = "cloudflare-kv"
broadcast = "cloudflare-do"
epoch_interval_ms = 5000

[cache.cloudflare]
kv_min_ttl_s = 300`,
  },
  bindings: {
    lang: 'json',
    file: 'wrangler.jsonc',
    code: `{
  "kv_namespaces": [{ "binding": "BRUST_CACHE", "id": "<wrangler kv namespace create brust-cache>" }],
  "durable_objects": { "bindings": [{ "name": "BRUST_CACHE_DO", "class_name": "BrustCacheDO" }] },
  "migrations": [{ "tag": "brust-cache-v1", "new_sqlite_classes": ["BrustCacheDO"] }]
}`,
  },
} satisfies Record<string, CodeBlockInput>

export interface CloudflareAdapterData {
  toc: TocItem[]
  blocks: Record<keyof typeof SRC, CodeBlockData>
}

export async function cloudflareAdapterLoader(): Promise<CloudflareAdapterData> {
  return {
    toc: [
      { id: 'configs', title: 'Three configurations' },
      { id: 'bindings', title: 'Bindings you declare' },
      { id: 'options', title: 'Options' },
      { id: 'guarantees', title: 'What each configuration guarantees' },
      { id: 'expect', title: 'What to expect' },
      { id: 'cost', title: 'Cost guidance' },
      { id: 'sources', title: 'Sources' },
    ],
    blocks: Object.fromEntries(Object.entries(SRC).map(([k, v]) => [k, codeBlock(v)])) as CloudflareAdapterData['blocks'],
  }
}

export default function CloudflareAdapter({ blocks }: CloudflareAdapterData) {
  return (
    <>
      <h1>Cloudflare KV and Durable Objects</h1>
      <Lead>
        Workers only. KV holds the page bodies; a Durable Object tells every isolate what was invalidated.
      </Lead>
      <CodeBlock code={blocks.install.code} lang={blocks.install.lang} cwd={blocks.install.cwd} html={blocks.install.html} />
      <p>
        Package <code>@brust/cache-cloudflare</code>. It imports nothing from Bun.
      </p>

      <h2 id="configs">Three configurations</h2>
      <TableWrap label="Configurations">
        <table>
          <thead>
            <tr>
              <th>
                <code>[cache]</code>
              </th>
              <th>What it is</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>adapter = &quot;cloudflare-kv&quot;</code>
              </td>
              <td>Pages in Workers KV. A store with no broadcast.</td>
            </tr>
            <tr>
              <td>
                <code>adapter = &quot;cloudflare-do&quot;</code>
              </td>
              <td>
                A Durable Object that carries invalidations (a pull broadcast). With <code>do_store = true</code> it also stores the pages, in 16 shard objects.
              </td>
            </tr>
            <tr>
              <td>
                <code>adapter = &quot;cloudflare-kv&quot;</code> and <code>broadcast = &quot;cloudflare-do&quot;</code>
              </td>
              <td>
                <b>The recommended pair.</b> KV holds the bodies and the Durable Object tells every isolate what was invalidated.
              </td>
            </tr>
          </tbody>
        </table>
      </TableWrap>
      <CodeBlock code={blocks.toml.code} lang={blocks.toml.lang} file={blocks.toml.file} html={blocks.toml.html} />

      <h2 id="bindings">Bindings you declare</h2>
      <p>
        brust adds no binding. Declare them in your own <code>wrangler.jsonc</code>. The build checks the top level and every <code>env.*</code> block, and if something is missing it fails and prints this snippet:
      </p>
      <CodeBlock code={blocks.bindings.code} lang={blocks.bindings.lang} file={blocks.bindings.file} html={blocks.bindings.html} />
      <p>
        <code>kv_namespaces</code> is needed for KV and the pair. The <code>durable_objects</code> binding and the migration are needed for <code>cloudflare-do</code> and the pair. <code>BrustCacheDO</code> must be a SQLite-backed class (<code>new_sqlite_classes</code>, or an <code>exports</code> entry with <code>&quot;storage&quot;: &quot;sqlite&quot;</code>). Create the KV namespace with <code>wrangler kv namespace create</code>.
      </p>
      <p>
        When a Durable Object is configured, <code>brust build</code> also writes <code>dist/cf/worker/main.js</code>, a short generated file that re-exports the Worker and <code>BrustCacheDO</code> so Cloudflare can bind the class, and points <code>main</code> at it. Do not write your own. The build refuses if <code>@brust/core-cf</code> ever ships a <code>worker/main.js</code> itself.
      </p>

      <h2 id="options">Options</h2>
      <p>
        These go under <code>[cache.cloudflare]</code>. An unknown key in this table is an error that names it. <code>env:</code> values are not allowed on this target.
      </p>
      <TableWrap label="Cloudflare adapter options">
        <table>
          <thead>
            <tr>
              <th>Key</th>
              <th>Used by</th>
              <th>Default</th>
              <th>Meaning</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>kv_binding</code>
              </td>
              <td>KV, pair</td>
              <td>
                <code>&quot;BRUST_CACHE&quot;</code>
              </td>
              <td>Name of the KV binding.</td>
            </tr>
            <tr>
              <td>
                <code>kv_min_ttl_s</code>
              </td>
              <td>KV, pair</td>
              <td>
                <code>300</code>
              </td>
              <td>
                <code>0..31536000</code>. A route whose TTL is smaller is not written to KV (KV&rsquo;s own floor is 60 s).
              </td>
            </tr>
            <tr>
              <td>
                <code>do_binding</code>
              </td>
              <td>DO, pair</td>
              <td>
                <code>&quot;BRUST_CACHE_DO&quot;</code>
              </td>
              <td>
                Name of the Durable Object binding; its <code>class_name</code> must be <code>BrustCacheDO</code>.
              </td>
            </tr>
            <tr>
              <td>
                <code>do_store</code>
              </td>
              <td>
                <code>cloudflare-do</code>
              </td>
              <td>
                <code>false</code>
              </td>
              <td>
                <code>true</code> stores pages in 16 Durable Object shards. Ignored with the pair.
              </td>
            </tr>
          </tbody>
        </table>
      </TableWrap>
      <Note tag="Caveat">
        <code>[cache.cloudflare]</code> is ignored for <code>adapter = &quot;custom&quot;</code>. The build reads <code>[cache.redis]</code> and <code>[cache.cloudflare]</code> only for built-in adapters, and without a warning. A custom adapter that calls <code>kvAdapter(&#123; binding, min_ttl_s &#125;)</code>, <code>doAdapter(&#123; binding, store &#125;)</code> or <code>combine(kv, do)</code> itself (all exported by <code>@brust/cache-cloudflare</code>) must pass its options through <code>[cache.options]</code> or in code, using the programmatic option names: <code>binding</code>, <code>min_ttl_s</code>, <code>store</code>.
      </Note>
      <Note tag="Caveat">
        Migrations in <code>env</code> blocks. The build accepts a <code>migrations</code> or <code>exports</code> declaration of the class at the top level for an <code>env.*</code> block. It has not been verified that <code>wrangler deploy --env &lt;name&gt;</code> applies a top-level <code>migrations</code> entry to that environment. If you deploy an <code>env</code>, declare the bindings and the migration inside that <code>env</code> block, and try <code>wrangler deploy --dry-run --env &lt;name&gt;</code> first.
      </Note>

      <h2 id="guarantees">What each configuration guarantees</h2>
      <TableWrap label="Guarantees">
        <table>
          <thead>
            <tr>
              <th>Config</th>
              <th>Store</th>
              <th>
                Other isolates after <code>cache.invalidate</code>
              </th>
              <th>A stale page served again?</th>
              <th>Free-plan cost driver</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>cloudflare-kv</code> alone
              </td>
              <td>KV, unguarded</td>
              <td>up to the page TTL (no broadcast)</td>
              <td>
                <b>yes</b>, up to the TTL (at least 300 s by default)
              </td>
              <td>1 KV write per tier-1 miss</td>
            </tr>
            <tr>
              <td>
                <code>cloudflare-do</code>, <code>do_store = false</code>
              </td>
              <td>none (tier 1 only)</td>
              <td>
                within <code>epoch_interval_ms</code> plus one round trip
              </td>
              <td>no</td>
              <td>1 DO request per poll per isolate</td>
            </tr>
            <tr>
              <td>
                <code>cloudflare-do</code>, <code>do_store = true</code>
              </td>
              <td>DO shards, exact write guard</td>
              <td>
                within <code>epoch_interval_ms</code> plus one round trip
              </td>
              <td>no (the rows are deleted)</td>
              <td>plus 1 DO request per tier-1 miss, about 18 per invalidation</td>
            </tr>
            <tr>
              <td>
                KV + <code>broadcast = &quot;cloudflare-do&quot;</code>
              </td>
              <td>KV, guarded by per-isolate floors</td>
              <td>
                within <code>epoch_interval_ms</code> plus one round trip
              </td>
              <td>no, once the isolate knows the invalidation</td>
              <td>1 KV write per miss plus the DO polls</td>
            </tr>
          </tbody>
        </table>
      </TableWrap>
      <p>
        <b>KV alone never invalidates.</b> Tier-2 keys hash the route prefix, method, path and query, so KV cannot list the pages under a tag or a path without extra index writes. Use the pair unless a stale page for up to its TTL is acceptable.
      </p>
      <p>
        <b>How the pair stays correct.</b> Each isolate keeps, for every tag and path, the sequence number of the last invalidation it knows. It seeds this from the Durable Object when it starts and after a restart, raises it from every event it polls, and raises it from its own invalidations. A KV page whose write stamp is older than the floor of its tags or path, or which has no stamp, is treated as a miss. A stale write from a lagging isolate can land in KV, but every isolate that knows the invalidation, including a new one, rejects it. The cost is an extra render, never a stale page.
      </p>

      <h2 id="expect">Things that behave in ways you should expect</h2>
      <ul>
        <li>
          <b>KV can hide a fresh page for up to 60 s per location.</b> The adapter reads KV with a 60-second <code>cacheTtl</code>, and KV allows one write per second per key. After an invalidation, a hot page&rsquo;s new value may stay invisible at a location&rsquo;s KV cache for up to a minute. Each isolate there then misses (the old value is rejected by the floor) and renders the page itself, and its write may get a 429 (the adapter returns false). This is correct, but expect a burst of renders after invalidating a popular page.
        </li>
        <li>
          <b>Lagging stamps cost misses.</b> Writes are stamped with the sequence number this isolate last saw, which can trail the Durable Object by up to <code>epoch_interval_ms</code>. A page rendered right after a remote invalidation may be written below another isolate&rsquo;s floor and be rejected there: an extra miss, never a stale serve.
        </li>
        <li>
          <b>A Durable Object restart clears every isolate once.</b> The Durable Object keeps its counters and floors in SQLite storage, so sequence numbers never go backward. Its event ring is in memory and it takes a new generation id each time it starts, for example after a deploy or after being evicted when idle. Every isolate sees the new generation on its next poll and clears its tier 1 once (<code>resets</code> +1). That is the safe behaviour. Expect it after quiet periods.
        </li>
        <li>
          <b>KV is eventually consistent.</b> Local <code>wrangler dev</code> KV is strongly consistent, so the propagation lag is not covered by brust&rsquo;s local tests.
        </li>
        <li>
          <b>A KV write is skipped</b> when the same isolate wrote an identical page less than 60 seconds earlier.
        </li>
      </ul>

      <h2 id="cost">Cost guidance</h2>
      <p>Prices and quotas were read from Cloudflare&rsquo;s pages on 2026-10-12 and change over time. Check them before you size.</p>
      <p>
        <b>Durable Object requests.</b> The pull broadcast makes one DO request per poll, and only an isolate that is serving requests polls (idle isolates cost nothing). A continuously busy isolate polls <code>86,400,000 / epoch_interval_ms</code> times a day. Cloudflare&rsquo;s Free plan includes 100,000 DO requests per day and 13,000 GB-s per day, and past a Free limit &ldquo;further operations of that type will fail with an error&rdquo;. Paid includes 1 million requests per month, then $0.15 per million (source C7).
      </p>
      <TableWrap label="Polling cost">
        <table>
          <thead>
            <tr>
              <th>
                <code>epoch_interval_ms</code>
              </th>
              <th>Polls per day per busy isolate</th>
              <th>Free: busy isolates the daily quota covers</th>
              <th>Paid: 10 busy isolates, 30 days</th>
              <th>Worst-case staleness</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>250 (minimum)</td>
              <td>345,600</td>
              <td>none (one isolate exceeds it)</td>
              <td>103.68 million requests, about $15.40</td>
              <td>about 0.25 s plus one round trip</td>
            </tr>
            <tr>
              <td>
                <b>1000 (default)</b>
              </td>
              <td>86,400</td>
              <td>one (86% of the quota)</td>
              <td>25.92 million, about $3.74</td>
              <td>about 1 s plus one round trip</td>
            </tr>
            <tr>
              <td>5000</td>
              <td>17,280</td>
              <td>about 5</td>
              <td>5.18 million, about $0.63</td>
              <td>about 5 s plus one round trip</td>
            </tr>
            <tr>
              <td>60000 (maximum)</td>
              <td>1,440</td>
              <td>about 69</td>
              <td>0.43 million, inside the included 1 million</td>
              <td>about 60 s plus one round trip</td>
            </tr>
          </tbody>
        </table>
      </TableWrap>
      <p>
        The Paid column is overage only: <code>(requests - 1 million) x $0.15 per million</code>; it excludes the plan&rsquo;s minimum charge and other usage. A DO kept active by polls uses about 11,000 GB-s a day at 128 MB, inside the Free 13,000.
      </p>
      <p>
        On the Free plan with steady traffic, set <code>epoch_interval_ms</code> to 5000 or more. When the quota runs out, polls fail, the adapter fails open and invalidation falls back to the TTL, and <code>poll_errors</code> rises. One DO object serves about 1,000 requests per second as a soft limit (source C10), which is roughly 1,000 busy isolates at 1 s.
      </p>
      <p>
        <b>KV.</b> Free allows 1,000 writes and 100,000 reads per day. Paid includes 1 million writes and 10 million reads per month, then $5.00 and $0.50 per million (source C8). Write-through costs one KV write per tier-2 miss of a page that is long-lived enough to be stored, so the Free write quota is the binding limit: it is why the default minimum TTL is 300 s.
      </p>

      <h2 id="sources">Sources</h2>
      <p>All fetched 2026-10-12.</p>
      <TableWrap label="Sources">
        <table>
          <thead>
            <tr>
              <th>Id</th>
              <th>Page</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>C7</td>
              <td>
                <a href="https://developers.cloudflare.com/durable-objects/platform/pricing/">developers.cloudflare.com/durable-objects/platform/pricing/</a>
              </td>
            </tr>
            <tr>
              <td>C8</td>
              <td>
                <a href="https://developers.cloudflare.com/kv/platform/pricing/">developers.cloudflare.com/kv/platform/pricing/</a> (also <a href="https://developers.cloudflare.com/kv/platform/limits/">kv/platform/limits/</a>)
              </td>
            </tr>
            <tr>
              <td>C9</td>
              <td>
                <a href="https://developers.cloudflare.com/kv/api/write-key-value-pairs/">developers.cloudflare.com/kv/api/write-key-value-pairs/</a>
              </td>
            </tr>
            <tr>
              <td>C10</td>
              <td>
                <a href="https://developers.cloudflare.com/durable-objects/platform/limits/">developers.cloudflare.com/durable-objects/platform/limits/</a>
              </td>
            </tr>
          </tbody>
        </table>
      </TableWrap>
    </>
  )
}
