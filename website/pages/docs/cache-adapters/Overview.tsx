// Cache adapters overview — port of docs/cache-adapters.md sections 1-3, 7, 8 and 10 (v2, reviewed). The backend
// sections live on the Redis, Cloudflare and Write-your-own pages.
import CodeBlock from '../../../components/CodeBlock'
import { type CodeBlockData, type CodeBlockInput, codeBlock } from '../../../lib/highlight'
import type { TocItem } from '../../../lib/nav'
import Lead from '../../../components/docs/Lead'
import TableWrap from '../../../components/docs/TableWrap'

const SRC = {
  tiers: {
    lang: 'text',
    code: `request -> tier 1: in-process cache (microseconds)  --hit-->  200, x-brust-cache: HIT
              | miss (cacheable route, no bypass, no Set-Cookie)
              v
           tier 2: adapter store.get(key)  --hit-->  copied into tier 1, 200, x-brust-cache: HIT-L2
              | miss, timeout or error
              v
           loader -> jobs -> render -> tier 1 insert -> tier 2 store.set (in the background)`,
  },
  config: {
    lang: 'toml',
    file: 'brust.toml',
    code: `[cache]
adapter = "custom"             # redis | dragonfly | cloudflare-kv | cloudflare-do | custom
module = "lib/cache.ts"        # custom only: a file inside the app
broadcast = "cloudflare-do"    # optional: take the broadcast from another built-in adapter
namespace = "my-app"           # default: package.json "name", else "brust"
get_timeout_ms = 50            # 1..1000; default 50 on native, 100 on Workers
max_body_bytes = 1048576       # 1..67108864; larger pages are not written to tier 2
epoch_interval_ms = 1000       # 250..60000; pull broadcasts only (Workers)

[cache.options]                # passed to a custom adapter's factory`,
  },
  stats: {
    lang: 'json',
    file: '/_brust/cache/stats',
    code: `"l2": { "adapter": "custom", "hits": 0, "misses": 0, "timeouts": 0, "errors": 0, "rejected_floor": 0,
        "sets": 0, "set_refused": 0, "set_dropped": 0, "set_oversize": 0, "published": 0, "publish_errors": 0,
        "received": 0, "skipped_own": 0, "resets": 0, "epoch_polls": 0, "poll_errors": 0 }`,
  },
} satisfies Record<string, CodeBlockInput>

export interface OverviewData {
  toc: TocItem[]
  blocks: Record<keyof typeof SRC, CodeBlockData>
}

export async function overviewLoader(): Promise<OverviewData> {
  return {
    toc: [
      { id: 'tiers', title: 'The two tiers' },
      { id: 'when', title: 'When to use one' },
      { id: 'config', title: 'Configuration' },
      { id: 'semantics', title: 'Semantics per backend' },
      { id: 'failure', title: 'Failure behaviour and stats' },
      { id: 'non-goals', title: 'What v1 does not do' },
    ],
    blocks: Object.fromEntries(Object.entries(SRC).map(([k, v]) => [k, codeBlock(v)])) as OverviewData['blocks'],
  }
}

export default function Overview({ blocks }: OverviewData) {
  return (
    <>
      <h1>Cache adapters</h1>
      <Lead>A cache adapter adds an optional shared second tier behind brust&rsquo;s in-process page cache.</Lead>
      <p>It does two jobs:</p>
      <ol>
        <li>
          <b>Store.</b> It keeps rendered pages where every process or isolate can read them.
        </li>
        <li>
          <b>Broadcast.</b> It tells every other instance when <code>cache.invalidate(...)</code> ran, so they drop the stale entries.
        </li>
      </ol>
      <p>
        An adapter is a plain TypeScript object. brust ships adapters for <a href="/docs/cache-adapters/redis">Redis and Dragonfly</a> and for <a href="/docs/cache-adapters/cloudflare">Cloudflare KV and Durable Objects</a>, and you can <a href="/docs/cache-adapters/write-your-own">write your own</a>. With no <code>[cache]</code> table in <code>brust.toml</code>, nothing here is active: behaviour and bytes are the same as without this feature.
      </p>

      <h2 id="tiers">The two tiers</h2>
      <CodeBlock code={blocks.tiers.code} lang={blocks.tiers.lang} html={blocks.tiers.html} />
      <ul>
        <li>
          <b>Tier 1</b> is always there: the Rust cache of the process (native) or of the isolate (Workers). The adapter is never called on a tier-1 hit.
        </li>
        <li>
          <b>Tier 2</b> exists only with an adapter that has a <code>store</code>. Only rendered page bodies are shared. Job results stay in tier 1. A <code>key</code> invalidation (job user keys) is broadcast, but the store ignores it.
        </li>
        <li>
          A <code>cache.invalidate(...)</code> call clears tier 1 of the process that ran it at once. The adapter then deletes the shared entries and broadcasts the event. Other instances replay it into their own tier 1.
        </li>
      </ul>

      <h2 id="when">When to use one</h2>
      <p>Use an adapter when:</p>
      <ul>
        <li>you run several brust processes or hosts and a mutation must show up on all of them quickly;</li>
        <li>
          you run on Cloudflare Workers, where every isolate has its own tier 1 and <code>cache.invalidate</code> is isolate-local (see <a href="/docs/cloudflare/cache">Cache on KV and DO</a>);
        </li>
        <li>renders are expensive and you want a warm shared cache after a restart.</li>
      </ul>
      <p>Do not use one for a single native process: tier 1 already does the job, and a miss then pays an extra round trip.</p>
      <p>
        An adapter never makes a request fail. A <code>get</code> that errors or exceeds <code>get_timeout_ms</code> counts as a tier-2 miss and the page renders normally.
      </p>

      <h2 id="config">Configuration</h2>
      <CodeBlock code={blocks.config.code} lang={blocks.config.lang} file={blocks.config.file} html={blocks.config.html} />
      <TableWrap label="cache keys">
        <table>
          <thead>
            <tr>
              <th>Key</th>
              <th>Default</th>
              <th>Meaning</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>adapter</code>
              </td>
              <td>none (no tier 2)</td>
              <td>
                One of the five names. Required when <code>[cache]</code> exists.
              </td>
            </tr>
            <tr>
              <td>
                <code>module</code>
              </td>
              <td />
              <td>
                <code>custom</code> only. The default export is a <code>CacheAdapter</code> or a factory <code>(options) =&gt; CacheAdapter</code>. A built-in adapter with <code>module</code> is a build error.
              </td>
            </tr>
            <tr>
              <td>
                <code>broadcast</code>
              </td>
              <td />
              <td>
                A built-in name. The store comes from <code>adapter</code>, the broadcast from this one (for example KV store plus Durable Object broadcast).
              </td>
            </tr>
            <tr>
              <td>
                <code>namespace</code>
              </td>
              <td>package name</td>
              <td>
                <code>1..64</code> characters from <code>A-Za-z0-9@._/-</code>. Shared entries are scoped by it.
              </td>
            </tr>
            <tr>
              <td>
                <code>get_timeout_ms</code>
              </td>
              <td>50 / 100</td>
              <td>The most a request waits for tier 2.</td>
            </tr>
            <tr>
              <td>
                <code>max_body_bytes</code>
              </td>
              <td>1048576</td>
              <td>Bodies above it are not written.</td>
            </tr>
            <tr>
              <td>
                <code>epoch_interval_ms</code>
              </td>
              <td>1000</td>
              <td>How often an isolate asks a pull broadcast for new events, at most. Lower means fresher and costlier (see the cost tables on the Cloudflare page).</td>
            </tr>
            <tr>
              <td>
                <code>[cache.redis]</code>, <code>[cache.cloudflare]</code>
              </td>
              <td />
              <td>
                Options of the built-ins: <a href="/docs/cache-adapters/redis">Redis</a>, <a href="/docs/cache-adapters/cloudflare">Cloudflare</a>.
              </td>
            </tr>
            <tr>
              <td>
                <code>[cache.options]</code>
              </td>
              <td />
              <td>
                Options of a <code>custom</code> adapter.
              </td>
            </tr>
          </tbody>
        </table>
      </TableWrap>
      <p>Rules the build enforces:</p>
      <ul>
        <li>Unknown keys are an error.</li>
        <li>
          Keys of every shared entry include a <b>build id</b>, a hash of your manifest, templates, <code>jobs.js</code> and <code>actions.js</code>. A deploy therefore starts with an empty tier 2; old entries expire by their TTL. Plan for a cold cache after each deploy.
        </li>
        <li>
          A built-in adapter is an opt-in package. If it is not installed the build says so, for example <code>adapter &quot;redis&quot; needs @brust/cache-redis (bun add @brust/cache-redis)</code>.
        </li>
        <li>
          <code>env:NAME</code> values in a built-in&rsquo;s option table are read from the process environment at start (native). A missing variable stops the start and names the variable, never its value. On <code>--target cloudflare</code>, an <code>env:</code> value is a build error: use a binding. Options of a <code>custom</code> adapter are passed as written; read the environment yourself.
        </li>
        <li>
          Native accepts <b>push</b> broadcasts only. Workers accept <b>pull</b> broadcasts only.
        </li>
      </ul>

      <h3 id="runtimes">Runtimes</h3>
      <TableWrap label="Runtimes">
        <table>
          <thead>
            <tr>
              <th />
              <th>
                Native (<code>brust start</code>)
              </th>
              <th>Workers</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Where the adapter runs</td>
              <td>in every Bun worker</td>
              <td>
                in the Worker (bundled into <code>brust-app.js</code>)
              </td>
            </tr>
            <tr>
              <td>Broadcast received by</td>
              <td>worker 0 of each process</td>
              <td>each isolate, by polling</td>
            </tr>
            <tr>
              <td>Write to tier 2</td>
              <td>background; dropped when no worker is free</td>
              <td>
                <code>waitUntil</code>, after the response
              </td>
            </tr>
          </tbody>
        </table>
      </TableWrap>

      <h2 id="semantics">Semantics per backend</h2>
      <p>What each backend gives:</p>
      <TableWrap label="Semantics per backend">
        <table>
          <thead>
            <tr>
              <th />
              <th>Redis / Dragonfly</th>
              <th>KV alone</th>
              <th>Durable Object</th>
              <th>KV + Durable Object</th>
              <th>Custom</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Runs on</td>
              <td>Bun</td>
              <td>Workers</td>
              <td>Workers</td>
              <td>Workers</td>
              <td>
                what <code>runtimes</code> says
              </td>
            </tr>
            <tr>
              <td>Store</td>
              <td>shared bodies, expire by TTL</td>
              <td>shared bodies, long-TTL only</td>
              <td>
                optional (<code>do_store</code>), 16 shards
              </td>
              <td>KV bodies</td>
              <td>optional</td>
            </tr>
            <tr>
              <td>Stale-write guard</td>
              <td>exact</td>
              <td>none: a stale body can live up to its TTL</td>
              <td>exact</td>
              <td>floors in each isolate</td>
              <td>whatever you implement</td>
            </tr>
            <tr>
              <td>Broadcast</td>
              <td>push, immediate</td>
              <td>none</td>
              <td>pull, ordered ring</td>
              <td>pull, ordered ring</td>
              <td>push or pull</td>
            </tr>
            <tr>
              <td>
                Other instances after <code>cache.invalidate</code>
              </td>
              <td>about pub/sub latency</td>
              <td>up to the TTL</td>
              <td>
                within about <code>epoch_interval_ms</code> plus one round trip
              </td>
              <td>same</td>
              <td>depends</td>
            </tr>
            <tr>
              <td>On failure</td>
              <td>fail-open; a gap clears tier 1</td>
              <td>fail-open</td>
              <td>fail-open; a restart clears tier 1 once</td>
              <td>fail-open</td>
              <td />
            </tr>
          </tbody>
        </table>
      </TableWrap>
      <p>
        <b>KV is a long-TTL store, not an invalidation channel.</b> KV writes are visible in other locations &ldquo;up to 60 seconds&rdquo; later (source C9 on the <a href="/docs/cache-adapters/cloudflare">Cloudflare page</a>), and KV has no compare-and-set, so brust cannot refuse a stale write. The KV adapter therefore refuses to store pages with a TTL below 300 seconds by default, and the docs advise pairing it with the Durable Object broadcast (<code>broadcast = &quot;cloudflare-do&quot;</code>). Alone, a deleted page can still be read for a while from other locations.
      </p>
      <p>
        A lost invalidation (publish failed, or the broadcast was down) leaves other instances stale for at most the page&rsquo;s TTL. Gaps the adapter can detect clear tier 1 instead. One blind spot on native: if the <i>last</i> event is lost and nothing follows it, no gap is seen until the next event, so the bound is the TTL.
      </p>

      <h2 id="failure">Failure behaviour and stats</h2>
      <p>Everything on the request path has a budget and fails open:</p>
      <TableWrap label="Failure behaviour">
        <table>
          <thead>
            <tr>
              <th>Operation</th>
              <th>On the request path?</th>
              <th>Budget</th>
              <th>On failure</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>tier-1 probe</td>
              <td>yes</td>
              <td>microseconds</td>
              <td>none</td>
            </tr>
            <tr>
              <td>
                <code>store.get</code> (tier-1 miss)
              </td>
              <td>yes</td>
              <td>
                <code>get_timeout_ms</code>
              </td>
              <td>tier-2 miss; no write follows</td>
            </tr>
            <tr>
              <td>
                pull poll (<code>since</code>)
              </td>
              <td>
                Workers: the first request after <code>epoch_interval_ms</code>, one at a time
              </td>
              <td>500 ms</td>
              <td>
                serve tier 1; <code>poll_errors</code> +1
              </td>
            </tr>
            <tr>
              <td>
                <code>store.set</code>
              </td>
              <td>no</td>
              <td>
                native: dropped if no worker is free; Workers: <code>waitUntil</code>
              </td>
              <td>counted, never an error to the client</td>
            </tr>
            <tr>
              <td>
                <code>store.invalidate</code> and <code>publish</code>
              </td>
              <td>no</td>
              <td />
              <td>
                <code>publish_errors</code> +1; others stale up to the TTL
              </td>
            </tr>
          </tbody>
        </table>
      </TableWrap>
      <p>
        A tier-2 hit answers with <code>x-brust-cache: HIT-L2</code>; a tier-1 hit stays <code>HIT</code>. A stored page&rsquo;s TTL is what is left of its original TTL, so a page never lives longer in total than its route&rsquo;s <code>ttl_seconds</code>.
      </p>
      <p>
        With an adapter configured, <code>/_brust/cache/stats</code> gains an <code>l2</code> object. Without one, the JSON is unchanged. On Workers the path needs <code>[cloudflare] stats = true</code>, and the numbers are per isolate.
      </p>
      <CodeBlock code={blocks.stats.code} lang={blocks.stats.lang} file={blocks.stats.file} html={blocks.stats.html} />
      <TableWrap label="l2 counters">
        <table>
          <thead>
            <tr>
              <th>Counter</th>
              <th>Meaning</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>hits</code>, <code>misses</code>
              </td>
              <td>tier-2 lookups that found or did not find a valid page</td>
            </tr>
            <tr>
              <td>
                <code>timeouts</code>, <code>errors</code>
              </td>
              <td>
                lookups that exceeded <code>get_timeout_ms</code>, or failed
              </td>
            </tr>
            <tr>
              <td>
                <code>rejected_floor</code>
              </td>
              <td>pages found but discarded because an invalidation newer than the page was already seen (Workers)</td>
            </tr>
            <tr>
              <td>
                <code>sets</code>, <code>set_refused</code>, <code>set_dropped</code>, <code>set_oversize</code>
              </td>
              <td>writes done, refused by the store&rsquo;s guard, dropped for lack of a free worker, skipped for size</td>
            </tr>
            <tr>
              <td>
                <code>published</code>, <code>publish_errors</code>
              </td>
              <td>invalidations broadcast, and broadcasts that failed</td>
            </tr>
            <tr>
              <td>
                <code>received</code>, <code>skipped_own</code>
              </td>
              <td>events replayed into tier 1, and events skipped because this instance sent them</td>
            </tr>
            <tr>
              <td>
                <code>resets</code>
              </td>
              <td>
                times tier 1 was cleared because of a gap, a new <code>gen</code>, or falling behind
              </td>
            </tr>
            <tr>
              <td>
                <code>epoch_polls</code>, <code>poll_errors</code>
              </td>
              <td>pull polls made and failed</td>
            </tr>
          </tbody>
        </table>
      </TableWrap>

      <h2 id="non-goals">What v1 does not do</h2>
      <ul>
        <li>
          <b>No stampede protection.</b> When a page expires, every instance that misses renders it. There is no cross-instance lock or render coalescing. A process-local single-flight is a possible follow-up.
        </li>
        <li>
          <b>No entry signing.</b> The store is trusted. Entries are scoped by namespace and build id only. If other parties can write to your Redis, they can put pages into your cache. Restrict access to it.
        </li>
        <li>
          <b>No sharing of job results.</b> Only page bodies are shared.
        </li>
        <li>
          <b>No streaming bodies.</b>
        </li>
        <li>
          <b>No Redis on Workers.</b> There is no TCP client a Worker can rely on. Use a custom adapter over an HTTP-based service.
        </li>
        <li>
          <b>No KV or Durable Object adapter on native.</b>
        </li>
      </ul>
    </>
  )
}
