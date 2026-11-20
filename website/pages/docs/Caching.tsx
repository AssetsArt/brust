// Caching — the per-route page cache (L1), its key, bypass, the x-brust-cache header, invalidation. This site is a
// static export (plan R6): the probe is a labelled browser simulation of the demo route's rules, and the real headers
// are a transcript recorded from `brust start` (curl -sI x3, 2026-10-13, brust 2.0.0-alpha.4), not typed by hand.
import CodeBlock from '../../components/CodeBlock'
import Note from '../../components/docs/Note'
import CacheProbe from '../../components/demos/CacheProbe'
import CacheKeyPlayground, { type Preset } from '../../components/demos/CacheKeyPlayground'
import PrefixExample, { type ExampleData } from '../../components/docs/PrefixExample'
import { cacheSource, EXAMPLES, type Example, PROBES } from '../../lib/cache-examples'
import transcripts from '../../lib/cache-transcripts.json'
import { type CodeBlockData, codeBlock } from '../../lib/highlight'
import type { TocItem } from '../../lib/nav'
import Frame from '../../components/docs/Frame'
import Lead from '../../components/docs/Lead'
import TableWrap from '../../components/docs/TableWrap'

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
cache.invalidate({ path: '/pokemon/pikachu' })   // every cached query of that path, GET by default

// one app serving many hosts: a route with prefix: 'request(host)'
cache.invalidate({ prefix: 'a.test', path: '/about' })  // that path, that host only
cache.invalidate({ prefix: 'a.test', tags: ['page'] })  // that host's tagged pages only
cache.invalidate({ prefix: 'a.test' })                  // every cached page of that host`

// recorded from `brust build && brust start --port 0` of this site, three `curl -sI` runs; do not edit by hand
const RECORDED = `$ curl -sI 'http://127.0.0.1:53577/demo/pokemon/eevee?v=docs'
HTTP/1.1 200 OK
content-type: text/html; charset=utf-8
x-brust-cache: MISS
content-length: 4453
x-powered-by: brust/2.0.0-alpha.4
date: Tue, 13 Oct 2026 15:20:02 GMT

$ curl -sI 'http://127.0.0.1:53577/demo/pokemon/eevee?v=docs'
HTTP/1.1 200 OK
content-type: text/html; charset=utf-8
x-brust-cache: HIT
content-length: 4453
x-powered-by: brust/2.0.0-alpha.4
date: Tue, 13 Oct 2026 15:20:02 GMT

$ curl -sI 'http://127.0.0.1:53577/demo/pokemon/eevee?v=docs&nocache=1'
HTTP/1.1 200 OK
content-type: text/html; charset=utf-8
x-brust-cache: BYPASS
content-length: 4453
x-powered-by: brust/2.0.0-alpha.4
date: Tue, 13 Oct 2026 15:20:02 GMT`

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
      { id: 'layers', title: 'Every cache layer' },
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
    <>
      <h1>Caching</h1>
      <Lead>A route with a cache field is stored in the Rust server's memory after its first render. A hit is answered without calling Bun.</Lead>

      <h2 id="route">Cache a route</h2>
      <CodeBlock code={blocks.route.code} lang={blocks.route.lang} file={blocks.route.file} html={blocks.route.html} />
      <CodeBlock code={blocks.config.code} lang={blocks.config.lang} file={blocks.config.file} html={blocks.config.html} />
      <p>
        <code>bypass</code> and <code>prefix</code> are small expressions over the request, such as <code>query(nocache)</code> or <code>cookie(session)</code>. The whole grammar, with examples that split the cache, is in{' '}
        <a href="#prefix">Split the cache with prefix</a>. A layout route cannot have a cache: put it on the leaf.
      </p>

      <h2 id="probe">Watch it work</h2>
      <p>
        The button requests <code>/demo/pokemon/{'{name}'}</code> three times with a fresh query string: the same URL twice, then with <code>?nocache=1</code>. This site is built to ship as static files, so the requests go to a simulation of the route's rules in your browser, and each row shows the <code>x-brust-cache</code> header a brust server sends for it.
      </p>
      <Frame title="Simulated demo" label="CacheProbe · native">
          <CacheProbe names={names} />
        
      </Frame>
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
        <li>
          A response whose <code>Vary</code> names any field other than <code>Accept-Encoding</code> is not stored either: the key holds no request header, so a page that varies on <code>Cookie</code> or <code>Accept-Language</code> would be served to everyone. A loader's <code>Cache-Control</code> of <code>no-store</code> or <code>private</code> also keeps a page out.
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
      <TableWrap label="Cache key expressions">
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
          {/* source: key_expr.rs:175-189 (Parser::expr: a quoted string, or a bare word not followed by `(`, is a literal), :296-311 (ident: a name is letters, digits, _ and -), :313-326 (string_lit: it ends at the next matching quote, so there are no escapes) */}
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
      </TableWrap>
      <p>
        For <code>bypass</code> the rule is the other way round: a non-empty result means skip the cache for that request. A wrong expression is a build error that names the problem.
      </p>
      {/* source: key_expr.rs Expr::parse (F553: a trailing || or && names the function to write) */}
      <p>
        There are no operators: several conditions are <code>or(a, b)</code> or <code>and(a, b)</code>. <code>cookie(a) || query(b)</code> stops the build with <code>'||' is not an operator: write or(a, b)</code>.
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
      <div className="grid max-w-[68ch] grid-cols-[auto_1fr] gap-[.9rem] rounded-[2px] border border-rule bg-sheet px-4 py-[.85rem] text-[15px]">
        <span className="mt-[.15rem] h-fit rounded-[3px] bg-amber-fill px-[.4rem] py-[.05rem] font-mono text-[11px] text-on-amber">Pitfalls</span>
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
      <Frame title="Live demo" label="CacheKeyPlayground · react">
          <CacheKeyPlayground presets={presets} />
        
      </Frame>

      <h2 id="invalidate">Invalidate</h2>
      <p>Call it from server code (a loader or an action) after the data changed:</p>
      <CodeBlock code={blocks.invalidate.code} lang={blocks.invalidate.lang} file={blocks.invalidate.file} html={blocks.invalidate.html} />
      {/* source: crates/brust-core/src/core.rs:192-221 (Core::invalidate: tags -> both caches, path -> pages of that path, prefix narrows the page side and skips the job cache) */}
      <p>
        <code>tags</code> drops the tagged pages and the server results cached under those tags; <code>path</code> drops that path's pages. In the browser, <code>cache.invalidate</code> throws: it is server-only.
      </p>
      <h3 id="invalidate-prefix">One prefix at a time</h3>
      {/* source: crates/brust-server/src/cache/l1.rs:529-545 (invalidate_path / invalidate_prefix compare the stored key prefix with ==), crates/brust-core/src/cache/local.rs (same on Workers) */}
      <p>
        When a route's key has a <a href="#prefix">prefix</a>, every value of it is its own set of pages. One app serving many hosts with <code>prefix: 'request(host)'</code> keeps a copy of <code>/about</code> per host. Add <code>prefix</code> to the call to reach one of them:
        with <code>path</code> it drops that path for that prefix, with <code>tags</code> that prefix's tagged pages, and alone every cached page of that prefix (any path, query and method; add <code>method</code> to keep to one). Without{' '}
        <code>prefix</code> the call drops every prefix's pages, as before.
      </p>
      <ul>
        {/* source: crates/brust-core/src/cache/conformance.rs (invalidate_path_with_a_prefix_leaves_other_prefixes: '' matches only routes with no prefix) */}
        <li>
          The value is compared with the evaluated prefix exactly, as the key stores it: the string your expression produced for that request, not the expression. <code>''</code> is a value too: it matches the pages of routes with no prefix (or whose prefix evaluated to nothing).
        </li>
        {/* source: crates/brust-core/src/core.rs:202-205 (with a prefix, tags do not reach the job cache) */}
        <li>
          <code>prefix</code> reaches pages only. Server results cached with <code>cache(Component, {'{ tags }'})</code> carry no prefix, so <code>{'{ prefix, tags }'}</code> leaves them alone and reports <code>jobRemoved: 0</code>; call <code>{'{ tags }'}</code> without a prefix to drop them too.
        </li>
        {/* source: packages/brust/src/cache.ts:13-21 (checkInvalidateArgs), crates/brust-core/src/config.rs:428-441 (InvalidateArgs::validate) */}
        <li>
          <code>prefix</code> with <code>key</code> is refused with a <code>TypeError</code>: <code>key</code> names a server result, not a page. Make two calls.
        </li>
        {/* source: packages/brust/src/cache-adapter/runtime.ts (afterInvalidate: store.invalidate then publish with the same args), crates/brust-core/src/l2.rs:276-300 (the replayed floor is scoped by prefix) */}
        <li>
          With a <a href="/docs/cache-adapters/overview">cache adapter</a> the prefix goes with the event: the shared store deletes that prefix's pages only, and every instance replays it the same way.
        </li>
      </ul>

      <h2 id="layers">Every cache layer</h2>
      <p>
        A running server keeps six caches. Only the first three hold a whole page or a server result you chose to cache; the last three belong to runtime components. The table says what each one keys on, how long it lives, what a route{' '}
        <code>bypass</code> skips, and where you configure it.
      </p>
      {/* source: crates/brust-core/src/components.rs (html_key: the ref, the artifact digest and the props; cache_html and cached_html are private, and no function removes an entry by key), crates/brust-core/src/pipeline.rs:334-372 (a bypass leaves the key empty: L1 and L2 are not read, and not written), :1458-1464 (bypass skips L1 read AND write), :668-670 (ttl_seconds, capped at NEGATIVE_TTL_SECS when a slot's ref is missing), :558 (lookup_jobs does not look at the bypass), :615-623 (the island HTML cache is used on every render); crates/brust-server/src/cache/l1.rs and crates/brust-core/src/cache/local.rs (the page cache, Workers); crates/brust-core/src/l2.rs (the shared store); crates/brust-server/src/cache/job_cache.rs (bounded by entries, a per-entry ttl, `None` = no expiry), crates/brust-compiler/src/analyze/component.rs:227-309 (cache(Component, { key, tags, revalidate })), crates/brust-core/src/manifest.rs:160-168 (ttl_seconds); crates/brust-core/src/components.rs:29-34 (NEGATIVE_ENTRIES, NEGATIVE_TTL_SECS), :36-44 (MAX_SLOT_OUTPUT_BYTES, HTML_CACHE_BYTES), :236-278 (HtmlCache, html_key), :406-413 (warm, html, negative), :823-889 (what is stored and what is not); crates/brust-napi/src/server.rs:340-341, :389-390 (l1_capacity, job_cache_capacity default 1000); crates/brust-core/src/cache/local.rs:39-42 (Workers 256 and 512); docs RuntimeComponents.tsx (Warm artifacts, Islands you render yourself), cache-adapters/Overview.tsx (#tiers, #semantics, #failure) */}
      <TableWrap label="Cache layers">
        <table>
          <thead>
            <tr>
              <th>Layer</th>
              <th>Key</th>
              <th>Lifetime</th>
              <th>What is stored</th>
              <th>A route <code>bypass</code></th>
              <th>Configured by</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Page cache</td>
              <td>
                The prefix, method, path and sorted query (<a href="#key">above</a>)
              </td>
              <td>
                The route&rsquo;s <code>ttl_seconds</code>, or until invalidated; at most 10 seconds when a runtime component&rsquo;s ref was missing
              </td>
              <td>The rendered page, a 200 only</td>
              <td>Skips it: no read, no write</td>
              <td>
                The route&rsquo;s <code>cache</code>; 1000 entries on a native server, <code>[cloudflare] l1_capacity</code> on Workers (default 256)
              </td>
            </tr>
            <tr>
              <td>
                Shared store (<a href="/docs/cache-adapters/overview#tiers">cache adapter</a>)
              </td>
              <td>The same page key, in the adapter&rsquo;s namespace</td>
              <td>The route&rsquo;s <code>ttl_seconds</code>, or until invalidated</td>
              <td>The rendered page body</td>
              <td>Skips it too: no read, no write</td>
              <td>
                <code>[cache]</code> in <code>brust.toml</code>
              </td>
            </tr>
            <tr>
              <td>
                Job cache, <code>cache(Component, {'{ … }'})</code>
              </td>
              <td>
                The job&rsquo;s input, or what your <code>key</code> returns
              </td>
              <td>
                <code>revalidate</code> seconds; without it, until evicted or invalidated
              </td>
              <td>The JSON result of a server job</td>
              <td>Does not skip it: a bypassed page still reads and fills it</td>
              <td>
                <code>key</code>, <code>tags</code> and <code>revalidate</code> on the component; 1000 entries on a native server (a count, not bytes), <code>[cloudflare] job_cache_capacity</code> on Workers (default 512)
              </td>
            </tr>
            <tr>
              <td>
                Runtime components: artifacts
              </td>
              <td>The component&rsquo;s ref</td>
              <td>Until evicted, least recently used first</td>
              <td>The resolved artifact, up to 512 KiB each</td>
              <td>Does not skip it</td>
              <td>
                <code>[components] cache_entries</code>, default 2048
              </td>
            </tr>
            <tr>
              <td>
                Runtime components: missing or refused refs
              </td>
              <td>The component&rsquo;s ref</td>
              <td>10 seconds</td>
              <td>The answer that a ref is missing or refused</td>
              <td>Does not skip it</td>
              <td>Fixed: 4096 entries</td>
            </tr>
            <tr>
              <td>
                Runtime components: island HTML (<code>components.render</code>)
              </td>
              <td>The ref, the artifact&rsquo;s digest and the canonical props</td>
              <td>
                No time limit, and no call drops one entry. It leaves when it is evicted, when the ref has a new artifact, or when the server restarts. To keep an answer out of it, return <code>ctx.notNow()</code> from <code>render</code>
              </td>
              <td>
                The HTML <code>render</code> returned, and <code>null</code> too. Not stored: <code>ctx.notNow()</code>, a throw, more than 4 MiB, or no answer; the
                page is then not stored either
              </td>
              <td>Does not skip it</td>
              <td>
                <code>[components] cache_entries</code> (default 2048) and 64 MiB in total; a value over the byte cap is not stored
              </td>
            </tr>
          </tbody>
        </table>
      </TableWrap>
      {/* source: crates/brust-core/src/render.rs:86-112 (Renderer::from_templates: one parse at boot, auto-reload off) */}
      <p>
        Templates are not on the list: the server parses them once at start and never reloads them, so there is nothing to tune or to invalidate. Runtime components and their cache settings are described in{' '}
        <a href="/docs/runtime-components#island">Runtime components</a>.
      </p>

      <h2 id="shared">Across instances</h2>
      <p>
        The page cache lives in one server's memory. To share it between instances, and to send every invalidation to all of them, configure a cache adapter (Redis or Dragonfly, Cloudflare KV or Durable Objects, or your own) in <code>[cache]</code>. A hit from it is reported as <code>HIT-L2</code>. See <a href="/docs/cache-adapters/overview">Cache adapters</a>.
      </p>
    </>
  )
}
