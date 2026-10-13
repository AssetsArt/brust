// Caching — the per-route page cache (L1), its key, bypass, the x-brust-cache header, invalidation. This site is a
// static export (plan R6): the probe is a labelled browser simulation of the demo route's rules, and the real headers
// are a transcript recorded from `brust start` (curl -sI x3, 2026-10-13, brust 2.0.0-alpha.3), not typed by hand.
import CodeBlock from '../../components/CodeBlock'
import Note from '../../components/docs/Note'
import CacheProbe from '../../components/demos/CacheProbe'
import CacheKeyPlayground, { type Preset } from '../../components/demos/CacheKeyPlayground'
import PrefixExample, { type ExampleData } from '../../components/docs/PrefixExample'
import { cacheSource, EXAMPLES, type Example, PROBES } from '../../lib/cache-examples'
import transcripts from '../../lib/cache-transcripts.json'
import { type CodeBlockData, codeBlock } from '../../lib/highlight'
import type { TocItem } from '../../lib/nav'

export interface CachingData {
  toc: TocItem[]
  blocks: Record<'route' | 'config' | 'invalidate' | 'recorded', CodeBlockData>
  names: string[]
  ex: Record<'lang' | 'tenant' | 'ab' | 'plan' | 'device' | 'deploy', ExampleData>
  probe: Record<'decode' | 'ambiguous', ExampleData>
  presets: Preset[]
}

const ROUTE = `// routes.tsx: this site's demo route
{
  path: '/demo/pokemon/{name}',
  Component: DemoPokemonPage,
  loader: demoPokemonLoader,
  cache: { ttl_seconds: 60, tags: ['pokemon'], bypass: 'query(nocache)' },
}`

const CONFIG = `interface RouteCacheConfig {
  ttl_seconds: number        // required, 0 or more
  tags?: string[]            // names to invalidate by
  bypass?: true | string     // true, or an expression: skip the cache when it is non-empty
  prefix?: string            // an expression added to the key
}`

const INVALIDATE = `// actions.ts: drop every page tagged 'team' after a real change
import { cache } from '@brust/core'

if (added) cache.invalidate({ tags: ['team'] })
cache.invalidate({ path: '/pokemon/pikachu' })   // every cached query of that path, GET by default`

// recorded from `brust build && brust start --port 0` of this site, three `curl -sI` runs; do not edit by hand
const RECORDED = `$ curl -sI 'http://127.0.0.1:55084/demo/pokemon/eevee?v=docs'
HTTP/1.1 200 OK
content-type: text/html; charset=utf-8
x-brust-cache: MISS
content-length: 2238
x-powered-by: brust/2.0.0-alpha.3
date: Tue, 13 Oct 2026 01:45:40 GMT

$ curl -sI 'http://127.0.0.1:55084/demo/pokemon/eevee?v=docs'
HTTP/1.1 200 OK
content-type: text/html; charset=utf-8
x-brust-cache: HIT
content-length: 2238
x-powered-by: brust/2.0.0-alpha.3
date: Tue, 13 Oct 2026 01:45:40 GMT

$ curl -sI 'http://127.0.0.1:55084/demo/pokemon/eevee?v=docs&nocache=1'
HTTP/1.1 200 OK
content-type: text/html; charset=utf-8
x-brust-cache: BYPASS
content-length: 2238
x-powered-by: brust/2.0.0-alpha.3
date: Tue, 13 Oct 2026 01:45:40 GMT`

// The prefix examples (lib/cache-examples.ts) with the transcripts recorded from a real `brust start` of test/fixtures/cache-prefix.
function exampleData(ex: Example, n: number): ExampleData {
  const t = transcripts.find((x) => x.id === ex.id)
  if (!t) throw new Error(`lib/cache-transcripts.json has no ${ex.id}: run bun scripts/capture-cache-prefix.ts`)
  return {
    n,
    title: ex.title,
    blurb: ex.blurb,
    route: ex.route,
    cache: codeBlock({ lang: 'ts', file: `routes.tsx · ${ex.route}`, code: cacheSource(ex.cache) }),
    transcript: codeBlock({ lang: 'sh', cwd: 'recorded from brust start', code: t.steps.map((st) => `$ ${st.command}\n${st.output}`).join('\n') }),
  }
}

// The playground starts from each example's most telling request (the first step that sends a cookie, header or query).
function preset(ex: Example): Preset {
  const s = ex.steps.find((st) => st.cookies || st.headers || st.query) ?? ex.steps[0]!
  const path = s.path ?? ex.path
  return {
    id: ex.id,
    label: ex.title,
    prefix: ex.cache.prefix ?? '',
    bypass: ex.cache.bypass ?? '',
    url: s.query ? `${path}?${s.query}` : path,
    host: s.headers?.find(([k]) => k.toLowerCase() === 'host')?.[1] ?? 'example.com',
    cookies: s.cookies ?? '',
    headers: (s.headers ?? []).filter(([k]) => k.toLowerCase() !== 'host').map(([k, v]) => `${k}: ${v}`).join('\n'),
    params: ex.route.includes('{name}') ? `name=${path.split('/').pop()}` : '',
  }
}

export async function cachingLoader(): Promise<CachingData> {
  return {
    toc: [
      { id: 'route', title: 'Cache a route' },
      { id: 'probe', title: 'Watch it work' },
      { id: 'key', title: 'What is stored, under which key' },
      { id: 'prefix', title: 'Split the cache with prefix' },
      { id: 'invalidate', title: 'Invalidate' },
      { id: 'shared', title: 'Across instances' },
    ],
    blocks: {
      route: codeBlock({ lang: 'ts', file: 'routes.tsx', code: ROUTE }),
      config: codeBlock({ lang: 'ts', file: '@brust/core/routes', code: CONFIG }),
      invalidate: codeBlock({ lang: 'ts', file: 'actions.ts', code: INVALIDATE }),
      recorded: codeBlock({ lang: 'sh', cwd: '~/brust/website', code: RECORDED }),
    },
    names: ['pikachu', 'eevee', 'snorlax', 'gengar', 'lapras', 'dragonite'],
    ex: {
      lang: exampleData(EXAMPLES[0]!, 1),
      tenant: exampleData(EXAMPLES[1]!, 2),
      ab: exampleData(EXAMPLES[2]!, 3),
      plan: exampleData(EXAMPLES[3]!, 4),
      device: exampleData(EXAMPLES[4]!, 5),
      deploy: exampleData(EXAMPLES[5]!, 6),
    },
    probe: { decode: exampleData(PROBES[0]!, 0), ambiguous: exampleData(PROBES[1]!, 0) },
    presets: EXAMPLES.map(preset),
  }
}

export default function Caching({ blocks, names, ex, probe, presets }: CachingData) {
  return (
    <section style={{ display: 'contents' }}>
      <h1>Caching</h1>
      <p className="lead">A route with a cache field is stored in the Rust server's memory after its first render. A hit is answered without calling Bun.</p>

      <h2 id="route">Cache a route</h2>
      <CodeBlock code={blocks.route.code} lang={blocks.route.lang} file={blocks.route.file} html={blocks.route.html} />
      <CodeBlock code={blocks.config.code} lang={blocks.config.lang} file={blocks.config.file} html={blocks.config.html} />
      <p>
        <code>bypass</code> and <code>prefix</code> are small expressions over the request, such as <code>query(nocache)</code> or <code>cookie(session)</code>. The whole grammar, with examples that split the cache, is in{' '}
        <a href="#prefix">Split the cache with prefix</a>. A layout route cannot have a cache: put it on the leaf.
      </p>

      <h2 id="probe">Watch it work</h2>
      <p>
        The button requests <a href="/demo/pokemon/pikachu">/demo/pokemon/{'{name}'}</a> three times with a fresh query string: the same URL twice, then with <code>?nocache=1</code>. This site is built to ship as static files, so the requests go to a simulation of the route's rules in your browser, and each row shows the <code>x-brust-cache</code> header a brust server sends for it.
      </p>
      <div className="browser">
        <div className="url">
          <span>Simulated demo</span>
          <span className="lbl">CacheProbe · native</span>
        </div>
        <div className="vp">
          <CacheProbe names={names} />
        </div>
      </div>
      <p>The same three requests against this site on <code>brust start</code>, recorded:</p>
      <CodeBlock code={blocks.recorded.code} lang={blocks.recorded.lang} cwd={blocks.recorded.cwd} html={blocks.recorded.html} />
      <table>
        <thead>
          <tr>
            <th>x-brust-cache</th>
            <th>Meaning</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>MISS</code>
            </td>
            <td>Not in the cache: the loader ran, the page was rendered and stored.</td>
          </tr>
          <tr>
            <td>
              <code>HIT</code>
            </td>
            <td>Served from memory. No loader, no render, no Bun.</td>
          </tr>
          <tr>
            <td>
              <code>BYPASS</code>
            </td>
            <td>The bypass expression matched, or the request was ambiguous (a repeated query name). Neither read nor stored.</td>
          </tr>
          <tr>
            <td>
              <code>HIT-L2</code>
            </td>
            <td>Not in this instance, found in the shared cache adapter.</td>
          </tr>
        </tbody>
      </table>
      <p>A route without a cache field sends no header.</p>

      <h2 id="key">What is stored, under which key</h2>
      <ul>
        <li>
          The key is the prefix, the method, the path and the sorted query string. <code>?a=1&amp;b=2</code> and <code>?b=2&amp;a=1</code> share an entry; a different query is a different entry.
        </li>
        <li>GET and HEAD share entries. Other methods are never cached.</li>
        <li>
          Only a <strong>200</strong> without <code>Set-Cookie</code> is stored, so a <code>notFound()</code> page is rendered every time.
        </li>
        <li>Cookies do not bypass by themselves. A page that paints per-user data must not be cached, or must use a bypass or prefix on that cookie.</li>
      </ul>
      {/* source: crates/brust-core/src/pipeline.rs:1120-1128 (query pairs are decoded for the expressions) and :1108-1116 (cookies and headers are taken as sent); key_expr.rs:12-14 (path params arrive decoded) */}
      <Note>
        Expressions see the query and the route params decoded (<code>%61</code> is <code>a</code>, <code>+</code> is a space), and header and cookie values exactly as sent. The cache key itself keeps the query as it was spelled.
      </Note>

      <h2 id="prefix">Split the cache with prefix</h2>
      {/* source: crates/brust-core/src/cache/mod.rs:93-112 (build_cache_key: prefix, method, path, sorted query), crates/brust-core/src/pipeline.rs:1163-1169 (the prefix is evaluated per request), :1080 (method is GET: HEAD shares entries) */}
      <p>
        By default every request for a route shares one entry per path and query. A <code>prefix</code> is an expression evaluated on <strong>every request</strong> and put in front of the key, so the same URL can have several entries: the key is the prefix,
        the method, the path and the sorted query. An empty prefix is valid, and means the shared entry.
      </p>

      <h3 id="grammar">The expressions</h3>
      <div className="table-wrap" tabIndex={0} role="region" aria-label="Cache key expressions">
      <table>
        <thead>
          <tr>
            <th>Expression</th>
            <th>What it returns</th>
          </tr>
        </thead>
        <tbody>
          {/* source: crates/brust-core/src/cache/key_expr.rs:62-68 (names match ignoring ASCII case), :70 (header), pipeline.rs:1100-1119 (header pairs as sent, the last value wins) */}
          <tr>
            <td>
              <code>header(name)</code>
            </td>
            <td>The request header, as sent, or an empty string. The name is matched ignoring case.</td>
          </tr>
          {/* source: key_expr.rs:71 (cookie), pipeline.rs:1108-1116 (every Cookie header is split on ; and the first =, values as sent) */}
          <tr>
            <td>
              <code>cookie(name)</code>
            </td>
            <td>The cookie of that name, as sent (not decoded), or an empty string.</td>
          </tr>
          {/* source: key_expr.rs:72 (query), pipeline.rs:1120-1128 and routing/routes.rs:267-279, :414-447 (decode_search, url_decode: %xx and + decoded) */}
          <tr>
            <td>
              <code>query(name)</code>
            </td>
            <td>
              The query value, <strong>percent-decoded</strong> (<code>+</code> is a space), or an empty string.
            </td>
          </tr>
          {/* source: key_expr.rs:73 (param) and :12-14 (path params arrive decoded) */}
          <tr>
            <td>
              <code>param(name)</code>
            </td>
            <td>
              The route parameter, decoded: <code>{'/pokemon/{name}'}</code> gives <code>param(name)</code>.
            </td>
          </tr>
          {/* source: key_expr.rs:74-81 (request fields), :179-187 (any other field is a build error), pipeline.rs:1080 (method is always GET for a cached page), :1133-1137 (host, scheme) */}
          <tr>
            <td>
              <code>request(host)</code>, <code>request(method)</code>, <code>request(scheme)</code>, <code>request(path)</code>
            </td>
            <td>The Host header; GET (HEAD shares the GET entries); http or https; the path without the query string.</td>
          </tr>
          {/* source: key_expr.rs:82 (the value is stored at parse time), :189-191 (std::env::var, empty when unset), :193-194 (refused on Workers) */}
          <tr>
            <td>
              <code>env(NAME)</code>
            </td>
            <td>
              The process environment variable, read <strong>once</strong>, when the route is installed (empty if unset). Refused when building for Cloudflare Workers, which has no process environment.
            </td>
          </tr>
          {/* source: key_expr.rs:124-135 (a quoted string or a bare word is a literal), :245-251 (a name is letters, digits, _ and -), :262-275 (no escapes in a quoted string) */}
          <tr>
            <td>
              <code>'text'</code>, <code>"text"</code>, or a bare word
            </td>
            <td>
              That text. A bare word is a literal too, so <code>header(Authorization)</code> works unquoted; a quoted string has no escapes.
            </td>
          </tr>
          {/* source: key_expr.rs:84-88 (or), :195-200 (needs at least one argument) */}
          <tr>
            <td>
              <code>or(a, b, …)</code>
            </td>
            <td>The first argument that is not empty, or an empty string.</td>
          </tr>
          {/* source: key_expr.rs:89-96 (and: all non-empty, joined by U+001F) */}
          <tr>
            <td>
              <code>and(a, b, …)</code>
            </td>
            <td>
              Every argument joined with the unit separator (U+001F) when none is empty, otherwise an empty string.
            </td>
          </tr>
          {/* source: key_expr.rs:97 (concat) */}
          <tr>
            <td>
              <code>concat(a, b, …)</code>
            </td>
            <td>The arguments joined, with nothing between them.</td>
          </tr>
          {/* source: key_expr.rs:98-105 (eq with 2 and 3 arguments), :224-237 (arity) */}
          <tr>
            <td>
              <code>eq(a, b)</code>
            </td>
            <td>
              <code>a</code> when it equals <code>b</code>, otherwise an empty string.
            </td>
          </tr>
          <tr>
            <td>
              <code>eq(a, b, v)</code>
            </td>
            <td>
              <code>v</code> when <code>a</code> equals <code>b</code>, otherwise an empty string.
            </td>
          </tr>
          {/* source: key_expr.rs:106-107 (to_ascii_lowercase / to_ascii_uppercase) */}
          <tr>
            <td>
              <code>lower(a)</code>, <code>upper(a)</code>
            </td>
            <td>ASCII case folding. Letters outside A to Z are left alone.</td>
          </tr>
          {/* source: key_expr.rs:238-240 (uuid and timestamp are rejected so a key is always reproducible) */}
          <tr>
            <td>
              <code>uuid()</code>, <code>timestamp()</code>
            </td>
            <td>Not allowed: the build stops, because a key must be the same for the same request.</td>
          </tr>
        </tbody>
      </table>
      </div>
      <p>
        For <code>bypass</code> the rule is the other way round: a non-empty result means skip the cache for that request. A wrong expression is a build error that names the problem.
      </p>

      <h3 id="examples">Six examples, run for real</h3>
      <p>
        Each example is a route <code>cache</code> block from the site's test fixture, served by <code>brust start</code>, and requested with <code>curl</code>. The transcripts are what the server printed: <code>BASE</code> is the address it listened on,
        the fixture renders how many times its loader has run, and the server was started with <code>BUILD_ID=r1</code>. A test replays them against a fresh server and fails if they stop matching.
      </p>
      <PrefixExample ex={ex.lang} />
      <PrefixExample ex={ex.tenant} />
      <PrefixExample ex={ex.ab} />
      <PrefixExample ex={ex.plan} />
      {/* observed: the signed-in request answers x-brust-cache: BYPASS (the bypass rule beats the prefix, whatever plan says) — see the transcript above */}
      <PrefixExample ex={ex.device} />
      <PrefixExample ex={ex.deploy} />

      <h3 id="pitfalls">Pitfalls</h3>
      {/* source: pipeline.rs:1085-1091 (a query name sent twice bypasses), :1130-1132 (names that differ only in case bypass), :1120-1128 (decoded query), :1155-1162 (bypass skips the read and the write) */}
      <div className="note">
        <span className="tag">Pitfalls</span>
        <div>
          <ul>
            <li>
              <strong>An unbounded value makes one entry per value.</strong> A raw <code>accept-language</code>, <code>user-agent</code> or user id in a prefix fills the cache with near-duplicates. Fold it to a small set with <code>eq</code> and{' '}
              <code>or</code>, as the A/B and device examples do.
            </li>
            <li>
              <strong>A page with per-user data needs bypass, not a prefix.</strong> A prefix keeps users apart only as long as the value never repeats between them; <code>bypass: 'cookie(session)'</code> keeps their pages out of the cache entirely.
            </li>
            <li>
              <strong>Values are not all decoded the same way.</strong> The query and route params reach the expression decoded; headers and cookies as sent. An <code>eq(cookie(x), '/')</code> will not match <code>%2F</code>.
            </li>
            <li>
              <strong>An ambiguous request is never cached.</strong> A query name sent twice, or two header, cookie or query names that differ only in case, answers <code>BYPASS</code>.
            </li>
          </ul>
        </div>
      </div>
      <PrefixExample ex={probe.decode} />
      <PrefixExample ex={probe.ambiguous} />

      <h3 id="playground">Try the expressions</h3>
      <p>Pick an example or type your own, describe a request, and read off the prefix and the key parts. It is the same rules as the server, evaluated in your browser.</p>
      <div className="browser">
        <div className="url">
          <span>Live demo</span>
          <span className="lbl">CacheKeyPlayground · react</span>
        </div>
        <div className="vp">
          <CacheKeyPlayground presets={presets} />
        </div>
      </div>

      <h2 id="invalidate">Invalidate</h2>
      <p>Call it from server code (a loader or an action) after the data changed:</p>
      <CodeBlock code={blocks.invalidate.code} lang={blocks.invalidate.lang} file={blocks.invalidate.file} html={blocks.invalidate.html} />
      <p>
        <code>tags</code> drops the tagged pages and the server results cached under those tags; <code>path</code> drops that path's pages. In the browser, <code>cache.invalidate</code> throws: it is server-only.
      </p>

      <h2 id="shared">Across instances</h2>
      <p>
        The page cache lives in one server's memory. To share it between instances, and to send every invalidation to all of them, configure a cache adapter (Redis or Dragonfly, Cloudflare KV or Durable Objects, or your own) in <code>[cache]</code>. A hit from it is reported as <code>HIT-L2</code>. See <a href="/docs/cache-adapters/overview">Cache adapters</a>.
      </p>
    </section>
  )
}
