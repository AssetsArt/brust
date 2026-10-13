// Redis and Dragonfly adapter — port of docs/cache-adapters.md section 5 and its cost note (v2, reviewed).
import CodeBlock from '../../../components/CodeBlock'
import Note from '../../../components/docs/Note'
import { type CodeBlockData, type CodeBlockInput, codeBlock } from '../../../lib/highlight'
import type { TocItem } from '../../../lib/nav'

const SRC = {
  install: { lang: 'sh', cwd: '~/my-app', code: '$ bun add @brust/cache-redis' },
  toml: {
    lang: 'toml',
    file: 'brust.toml',
    code: `[cache]
adapter = "redis"              # or "dragonfly"
namespace = "my-app"

[cache.redis]
url = "env:REDIS_URL"          # always env:NAME; a literal URL is a build error`,
  },
  run: { lang: 'sh', cwd: '~/my-app', code: '$ REDIS_URL=rediss://user:password@host:6380/0 brust start' },
} satisfies Record<string, CodeBlockInput>

export interface RedisData {
  toc: TocItem[]
  blocks: Record<keyof typeof SRC, CodeBlockData>
}

export async function redisLoader(): Promise<RedisData> {
  return {
    toc: [
      { id: 'setup', title: 'Setup' },
      { id: 'options', title: 'Options' },
      { id: 'keys', title: 'What it keeps in the server' },
      { id: 'guard', title: 'Guard and invalidation' },
      { id: 'connections', title: 'Connections' },
      { id: 'outages', title: 'Outages' },
      { id: 'dragonfly', title: 'Dragonfly' },
    ],
    blocks: Object.fromEntries(Object.entries(SRC).map(([k, v]) => [k, codeBlock(v)])) as RedisData['blocks'],
  }
}

export default function Redis({ blocks }: RedisData) {
  return (
    <>
      <h1>Redis and Dragonfly</h1>
      <p className="lead">
        One package serves both servers: <code>adapter = &quot;redis&quot;</code> or <code>adapter = &quot;dragonfly&quot;</code>. Native only; push broadcast over pub/sub.
      </p>

      <h2 id="setup">Setup</h2>
      <CodeBlock code={blocks.install.code} lang={blocks.install.lang} cwd={blocks.install.cwd} html={blocks.install.html} />
      <p>
        Package <code>@brust/cache-redis</code>. It uses Bun&rsquo;s built-in <code>RedisClient</code>, so it adds no npm dependency. It needs Bun 1.2.23 or newer and a Redis-compatible server 7.2 or newer. Bun&rsquo;s Redis pub/sub is still marked experimental by Bun; the adapter turns any lost message into a tier-1 clear rather than a stale page (below).
      </p>
      <p>
        Bun only. It does not run on Workers, because a Worker has no TCP client the adapter can rely on. On Workers, use a <a href="/docs/cache-adapters/write-your-own">custom adapter</a> over an HTTP-based Redis service.
      </p>
      <CodeBlock code={blocks.toml.code} lang={blocks.toml.lang} file={blocks.toml.file} html={blocks.toml.html} />
      <p>
        Run the app with <code>REDIS_URL</code> set. Credentials live only inside the URL. The adapter&rsquo;s log lines show <code>host:port</code> and never the password.
      </p>
      <CodeBlock code={blocks.run.code} lang={blocks.run.lang} cwd={blocks.run.cwd} html={blocks.run.html} />

      <h2 id="options">Options</h2>
      <p>
        These go under <code>[cache.redis]</code>. An unknown key stops the start with <code>cache-redis: unknown option &quot;&lt;key&gt;&quot;</code>.
      </p>
      <div className="table-wrap" tabIndex={0} role="region" aria-label="Redis options">
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
                <code>url</code>
              </td>
              <td>required</td>
              <td>
                <code>redis://</code>, <code>rediss://</code>, <code>redis+tls://</code> or <code>redis+unix://</code>. Must be written as <code>env:NAME</code>. If the variable is unset the start fails and names the variable.
              </td>
            </tr>
            <tr>
              <td>
                <code>tls</code>
              </td>
              <td>
                <code>false</code>
              </td>
              <td>
                <code>true</code>, <code>false</code>, or a table with <code>reject_unauthorized</code>, <code>server_name</code>, <code>ca_file</code> (a path to a PEM file, read at start).
              </td>
            </tr>
            <tr>
              <td>
                <code>connect_timeout_ms</code>
              </td>
              <td>2000</td>
              <td>
                <code>100..60000</code>. One bounded connect at start.
              </td>
            </tr>
            <tr>
              <td>
                <code>max_body_bytes</code>
              </td>
              <td>1048576</td>
              <td>
                <code>1..67108864</code>. Larger pages are not stored.
              </td>
            </tr>
            <tr>
              <td>
                <code>marker_ttl_ms</code>
              </td>
              <td>86400000</td>
              <td>
                <code>60000..604800000</code>. How long an invalidation marker is remembered; it should be longer than your longest page TTL.
              </td>
            </tr>
            <tr>
              <td>
                <code>unlink_batch</code>
              </td>
              <td>500</td>
              <td>
                <code>1..10000</code>. Pages deleted per <code>UNLINK</code> after an invalidation.
              </td>
            </tr>
            <tr>
              <td>
                <code>reconnect_min_ms</code>
              </td>
              <td>100</td>
              <td>
                <code>10..60000</code>. First reconnect delay.
              </td>
            </tr>
            <tr>
              <td>
                <code>reconnect_max_ms</code>
              </td>
              <td>5000</td>
              <td>
                <code>10..600000</code>. Cap of the exponential backoff (plus or minus 20% jitter).
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2 id="keys">What it keeps in the server</h2>
      <p>
        Every key of a namespace carries the hash tag <code>{'{brust:<namespace>}'}</code>, so the scripts also work on Redis Cluster (all keys in one slot).
      </p>
      <div className="table-wrap" tabIndex={0} role="region" aria-label="Redis keys">
        <table>
          <thead>
            <tr>
              <th>Key</th>
              <th>Holds</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>{'{brust:ns}:page:<key>'}</code>
              </td>
              <td>One page: a small header and the identity body, expiring with the page TTL. The key includes the build id.</td>
            </tr>
            <tr>
              <td>
                <code>{'{brust:ns}:tag:<tag>'}</code>, <code>{'{brust:ns}:path:<METHOD> <path>'}</code>
              </td>
              <td>Sets of the page keys under a tag or a path.</td>
            </tr>
            <tr>
              <td>
                <code>{'{brust:ns}:inval:tag:<tag>'}</code>, <code>{'{brust:ns}:inval:path:<METHOD> <path>'}</code>
              </td>
              <td>
                The sequence number of the last invalidation of that name, kept <code>marker_ttl_ms</code>.
              </td>
            </tr>
            <tr>
              <td>
                <code>{'{brust:ns}:seq'}</code>
              </td>
              <td>The invalidation counter. This is the stamp.</td>
            </tr>
            <tr>
              <td>
                <code>{'{brust:ns}:stage:<id>'}</code>
              </td>
              <td>A 30-second staging key used while writing a page.</td>
            </tr>
            <tr>
              <td>
                channel <code>brust:&lt;ns&gt;:inval</code>
              </td>
              <td>Pub/sub channel for invalidation events.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>Only page keys are scoped by build id. The index sets, markers, counter and channel are shared by all builds, so a rolling deploy keeps invalidating across old and new instances.</p>

      <h2 id="guard">Guard and invalidation</h2>
      <ul>
        <li>
          <b>A stale write is refused exactly.</b> <code>get</code> returns the counter as the stamp. <code>set</code> runs a Lua script that checks the invalidation markers of the page&rsquo;s tags and of its <code>METHOD path</code>, and refuses (returns false) if any is newer than the stamp. A page rendered before an invalidation therefore cannot be stored after it, even if the two race.
        </li>
        <li>
          <b>Invalidate and publish are one script.</b> It increments the counter, raises the markers and drops the index sets. The adapter then deletes the pages (<code>UNLINK</code>, in batches) and publishes <code>{'{seq, origin, args}'}</code> on the channel. Every script declares all its keys, as Dragonfly requires.
        </li>
        <li>
          <b>Receiving.</b> Worker 0 of each process holds the subscription and replays events into the process&rsquo;s tier 1. Events from the same process are skipped.
        </li>
      </ul>

      <h2 id="connections">Connections</h2>
      <p>
        Each Bun worker keeps one command connection. Worker 0 keeps one more for the subscription. A process with W workers therefore holds W + 1 connections to the server. Size <code>maxclients</code> for the number of processes times (W + 1). Beyond that, you pay for your own server.
      </p>

      <h2 id="outages">Outages and what tier 1 does</h2>
      <ul>
        <li>If the server is unreachable at start, the app still starts: the adapter tries one bounded connect, logs a warning and keeps retrying in the background.</li>
        <li>
          While disconnected, commands fail at once; they are not queued. Tier-2 <code>get</code>/<code>set</code> failures count as <code>errors</code>, failed publishes as <code>publish_errors</code>, and pages keep being served from tier 1 and rendered on a miss. Logged failures are rate-limited (the first, then every 10th).
        </li>
        <li>
          After every re-subscribe the adapter reads the counter. If it moved beyond the last event this process saw, tier 1 is cleared once (<code>resets</code> +1), so an event missed during the outage cannot leave a stale page.
        </li>
      </ul>
      <Note tag="Limits">
        Two limits are tracked as follow-ups. <b>Out-of-order delivery under concurrent invalidation:</b> the publish happens after the script, so two processes invalidating at the same moment can deliver events out of order. Other instances read that as a gap and clear their tier 1; this costs hit rate under bursts, it does not serve stale pages. <b>Orphaned pages after a dropped UNLINK batch:</b> the index sets are deleted inside the script, but pages are deleted afterwards. If the connection drops in between, those pages stay in Redis until their TTL. Instances that replayed the event reject them through the invalidation floor, so the cost is storage and an occasional extra render, not a stale page.
      </Note>

      <h2 id="dragonfly">Dragonfly</h2>
      <ul>
        <li>
          Same package, <code>adapter = &quot;dragonfly&quot;</code>. It was run against Dragonfly v2.0.2 in brust&rsquo;s tests.
        </li>
        <li>Dragonfly requires every key a script touches to be declared; the adapter&rsquo;s scripts do.</li>
        <li>
          When running the container yourself, pass <code>--ulimit memlock=-1</code>.
        </li>
      </ul>
    </>
  )
}
