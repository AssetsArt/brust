// Caching — the per-route page cache (L1), its key, bypass, the x-brust-cache header, invalidation. This site is a
// static export (plan R6): the probe is a labelled browser simulation of the demo route's rules, and the real headers
// are a transcript recorded from `brust start` (curl -sI x3, 2026-10-13, brust 2.0.0-alpha.3), not typed by hand.
import CodeBlock from '../../components/CodeBlock'
import Note from '../../components/docs/Note'
import CacheProbe from '../../components/demos/CacheProbe'
import { type CodeBlockData, codeBlock } from '../../lib/highlight'
import type { TocItem } from '../../lib/nav'

export interface CachingData {
  toc: TocItem[]
  blocks: Record<'route' | 'config' | 'invalidate' | 'recorded', CodeBlockData>
  names: string[]
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

export async function cachingLoader(): Promise<CachingData> {
  return {
    toc: [
      { id: 'route', title: 'Cache a route' },
      { id: 'probe', title: 'Watch it work' },
      { id: 'key', title: 'What is stored, under which key' },
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
  }
}

export default function Caching({ blocks, names }: CachingData) {
  return (
    <section style={{ display: 'contents' }}>
      <h1>Caching</h1>
      <p className="lead">A route with a cache field is stored in the Rust server's memory after its first render. A hit is answered without calling Bun.</p>

      <h2 id="route">Cache a route</h2>
      <CodeBlock code={blocks.route.code} lang={blocks.route.lang} file={blocks.route.file} html={blocks.route.html} />
      <CodeBlock code={blocks.config.code} lang={blocks.config.lang} file={blocks.config.file} html={blocks.config.html} />
      <p>
        <code>bypass</code> and <code>prefix</code> are small expressions over the request: <code>query(nocache)</code>, <code>cookie(session)</code>, <code>header(accept-language)</code>, combined with <code>or</code>, <code>and</code>, <code>concat</code>, <code>eq</code>, <code>lower</code>, <code>upper</code>. A layout route cannot have a cache: put it on the leaf.
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
      <Note>
        Expressions compare header, cookie and query values as they arrive, undecoded. Route params are compared decoded.
      </Note>

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
