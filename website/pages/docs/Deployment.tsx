// Deployment — the Bun server (what to ship, how to run and supervise it), static files (--target static), static pages
// plus actions on Cloudflare Pages, and Cloudflare Workers. The static sections cite their sources in `source:` comments
// (files at v2 @00e116c, merged into docs-site @0689b0c).
import CodeBlock from '../../components/CodeBlock'
import Note from '../../components/docs/Note'
import SwitchPanels from '../../components/demos/SwitchPanels'
import { type CodeBlockData, codeBlock } from '../../lib/highlight'
import type { TocItem } from '../../lib/nav'

export interface DeploymentData {
  toc: TocItem[]
  blocks: Record<'native' | 'cf' | 'static' | 'ssg' | 'tree' | 'hybrid' | 'pages', CodeBlockData>
  panels: { id: string; tab: string; note: string; text: string }[]
}

// source: docs/static.md §2 (a dynamic route needs ssg.params; ssg: false writes nothing) and packages/brust/src/routes.ts:71-81 (ssg is false or { params }, leaves only)
const SSG = `{
  path: '/poke/{name}',
  Component: Poke,
  loader: ({ params }) => getPokemon(params.name),
  ssg: { params: async () => (await listPokemon()).map((p) => ({ name: p.name })) },
},
{ path: '/live/{id}', Component: Live, ssg: false },`

// source: docs/static.md §3 (the output tree) and packages/brust/src/build/static.ts:1-6, :226-228, :251 (404.html, _redirects, ssg.json)
const TREE = `dist/static/index.html            /
dist/static/docs.html             /docs
dist/static/docs/intro.html       /docs/intro
dist/static/404.html              the * route (or a default one, with a warning)
dist/static/_brust/client/*.js    runtime, native chunks and island chunks
dist/static/public/**             ./public
dist/static/_headers              nosniff, X-Powered-By, cache-control for the assets
dist/static/_redirects            one line per redirect()
dist/static/ssg.json              pages, redirects, skipped routes, the 404 route, warnings`

// source: packages/brust/src/build/static-worker.ts:1-6, :16, :19-26 (the Worker, .assetsignore, _routes.json) and :57 (pages_build_output_dir)
const HYBRID = `dist/static/_worker.js/index.js   the Worker: the action prefix -> your actions, anything else -> the static files
dist/static/_worker.js/core/      the --target cloudflare worker tree (wasm host + your actions.ts)
dist/static/_routes.json          only the prefix and the deploy inputs reach the Worker
dist/static/.assetsignore         _worker.js, _routes.json, .assetsignore: never public assets
dist/wrangler.jsonc               the Pages project file: name, compatibility date, pages_build_output_dir`

export async function deploymentLoader(): Promise<DeploymentData> {
  return {
    toc: [
      { id: 'pick', title: 'Pick a target' },
      { id: 'bun', title: 'The Bun server' },
      { id: 'static', title: 'Static files' },
      { id: 'pages-actions', title: 'Static pages + actions on Pages' },
      { id: 'workers', title: 'Cloudflare Workers' },
    ],
    blocks: {
      native: codeBlock({ lang: 'sh', cwd: '/srv/pokedex', code: '$ bun install --production\n$ bun run build\n$ BRUST_ADDR=0.0.0.0 BRUST_PORT=8080 bun dist/index.js' }),
      cf: codeBlock({ lang: 'sh', cwd: '~/pokedex', code: '$ bun run dev:cf\n$ bun run deploy:cf' }),
      static: codeBlock({ lang: 'sh', cwd: '~/my-site', code: '$ brust build routes.tsx --target static\n$ brust build routes.tsx --target static --strict\n$ wrangler pages deploy dist/static' }),
      ssg: codeBlock({ lang: 'tsx', file: 'routes.tsx', code: SSG }),
      tree: codeBlock({ lang: 'text', file: 'dist/static/', code: TREE }),
      hybrid: codeBlock({ lang: 'text', file: 'dist/', code: HYBRID }),
      pages: codeBlock({ lang: 'sh', cwd: '~/my-site', code: '$ brust build routes.tsx --target static\n$ cd dist && wrangler pages deploy --project-name my-site' }),
    },
    panels: [
      {
        id: 'bun',
        tab: 'Bun server',
        note: 'One process: Rust serves HTTP, Bun workers run your code. Needs Bun on the host, no Rust toolchain.',
        text: '$ bun run build\n$ BRUST_PORT=8080 bun dist/index.js\n[brust] listening on 127.0.0.1:8080 (io: hyper(tokio))\n[brust] ready (10 workers)',
      },
      {
        // source: docs/static.md (intro and §7): pages written as files, no server and no Worker
        id: 'static',
        tab: 'Static files',
        note: 'Every page rendered at build time and written as a file. Any static host: Cloudflare Pages, Workers Static Assets. No server.',
        text: '$ brust build routes.tsx --target static\n$ wrangler pages deploy dist/static',
      },
      {
        id: 'workers',
        tab: 'Cloudflare Workers',
        note: 'The same app as a Worker: the prebuilt wasm host (@brust/core-cf) plus your bundled code. Needs wrangler.',
        text: '$ brust build routes.tsx --target cloudflare\n$ wrangler deploy -c dist/cf/wrangler.jsonc',
      },
    ],
  }
}

export default function Deployment({ blocks, panels }: DeploymentData) {
  return (
    <>
      <h1>Deployment</h1>
      <p className="lead">The same app runs as one Bun process on your own machine, as static files on any static host, or as a Cloudflare Worker.</p>

      <h2 id="pick">Pick a target</h2>
      <div className="browser">
        <div className="url">
          <span>Live demo</span>
          <span className="lbl">SwitchPanels · native</span>
        </div>
        <div className="vp">
          <SwitchPanels label="Targets" panels={panels} />
        </div>
      </div>

      <h2 id="bun">The Bun server</h2>
      <CodeBlock code={blocks.native.code} lang={blocks.native.lang} cwd={blocks.native.cwd} html={blocks.native.html} />
      <ul>
        <li>
          <code>bun dist/index.js</code> is the same as <code>brust start</code> with that <code>dist/</code>. Keep <code>dist/</code> inside the app: it imports <code>react</code> and <code>@brust/core</code> (and <code>elysia</code> for actions) from <code>node_modules</code> at runtime.
        </li>
        <li>The host needs Bun. The Rust server comes from the npm package for the platform: macOS or Linux (glibc or musl), arm64 or x64.</li>
        <li>Run it under a supervisor (systemd, a container restart policy): a dead worker stops the process with exit 1 after a drain, and it does not restart itself.</li>
        <li>
          There is no TLS in <code>brust start</code>. Put a proxy in front, and pass <code>Host</code> through (or set <code>X-Forwarded-Host</code>), or same-origin action POSTs get a 403.
        </li>
        <li>
          The page cache is per process. For several instances, add a cache adapter so they share pages and invalidations: <a href="/docs/cache-adapters/overview">Cache adapters</a>.
        </li>
      </ul>

      <h2 id="static">Static files</h2>
      {/* source: docs/static.md intro and §1 (the normal dist/, then every page rendered through the real server, byte-identical to brust start) */}
      <p>
        <code>--target static</code> builds the normal <code>dist/</code>, then renders every page through the real server and writes it to <code>dist/static/</code>. A written page is byte-identical to what <code>brust start</code> sends for that path: the same templates, jobs, islands and scripts. <code>brust start</code> still works on the same <code>dist/</code>.
      </p>
      <CodeBlock code={blocks.static.code} lang={blocks.static.lang} cwd={blocks.static.cwd} html={blocks.static.html} />
      <ul>
        {/* source: docs/static.md §2 table and packages/brust/src/build/ssg.ts:101 (ssg-params-missing) */}
        <li>
          A static pattern (<code>/</code>, <code>/docs/intro</code>) writes one page. A dynamic pattern needs <code>ssg.params</code>, which returns one record per page; without it the build fails with <code>ssg-params-missing</code>. <code>ssg: false</code> writes nothing for that route.
        </li>
        {/* source: packages/brust/src/routes.ts:76-81 (ssg allows only `params`, and only on leaf routes) */}
        <li>
          <code>ssg</code> has one field, <code>params</code>, and only on leaf routes. There is no client fallback for a path the build did not write: it is a 404.
        </li>
        {/* source: docs/static.md §3 and packages/brust/src/build/static.ts:226 (ssg-404) */}
        <li>
          The top-level <code>*</code> route becomes <code>404.html</code>. Without one the build writes a minimal page and warns <code>ssg-404</code>: with no <code>404.html</code>, Cloudflare Pages answers every unknown path with the home page.
        </li>
      </ul>
      <CodeBlock code={blocks.ssg.code} lang={blocks.ssg.lang} file={blocks.ssg.file} html={blocks.ssg.html} />
      <CodeBlock code={blocks.tree.code} lang={blocks.tree.lang} file={blocks.tree.file} html={blocks.tree.html} />
      <ul>
        {/* source: docs/static.md §3 ("There is no manifest, Jinja, jobs or actions file in it") */}
        <li>There is no manifest, template, job or actions file in <code>dist/static/</code>: only what a browser fetches.</li>
        {/* source: docs/static.md §5 and packages/brust/src/build/static.ts:248-249 (ssg-request-read; --strict makes it an error) */}
        <li>
          Loaders see an empty request: no headers, cookies or query. Each read is a warning <code>ssg-request-read</code>; <code>--strict</code> makes it a build error and keeps the previous <code>dist/</code>.
        </li>
        {/* source: docs/static.md §4 (redirects to _redirects, other statuses fail with ssg-render, loader headers dropped with ssg-headers) */}
        <li>
          A <code>redirect()</code> becomes a line in <code>_redirects</code>. Any other non-200 status fails the build (<code>ssg-render</code>), and headers a loader sets are dropped with a warning (<code>ssg-headers</code>).
        </li>
        {/* source: docs/static.md §6 and packages/brust/src/build/static.ts:48-52 (ssg-varies) */}
        <li>
          A route whose <code>cache.prefix</code> or <code>cache.bypass</code> reads a header, cookie, query or host fails with <code>ssg-varies</code>: a file is one page for everyone. <code>ttl_seconds</code> and <code>[cache]</code> do not apply to files.
        </li>
        {/* source: docs/static.md §7 (Pages serves /docs from docs.html, applies _headers/_redirects, 404.html with status 404; Workers Static Assets needs not_found_handling = "404-page") */}
        <li>
          Cloudflare Pages serves <code>/docs</code> from <code>docs.html</code>, applies <code>_headers</code> and <code>_redirects</code>, and answers unknown paths with <code>404.html</code>. Workers Static Assets works too, with <code>not_found_handling = "404-page"</code>.
        </li>
      </ul>

      <h2 id="pages-actions">Static pages + actions on Pages</h2>
      {/* source: docs/cloudflare.md §12 and packages/brust/src/build/static-worker.ts:1-6 (with [actions], --target static also writes a Pages advanced-mode Worker that serves only the action prefix) */}
      <p>
        With <code>[actions]</code> configured, <code>--target static</code> also writes a Cloudflare Pages Worker that serves <b>only</b> the action prefix. One Pages project serves the pages as free static files and the actions on the same domain.
      </p>
      <CodeBlock code={blocks.hybrid.code} lang={blocks.hybrid.lang} file={blocks.hybrid.file} html={blocks.hybrid.html} />
      <ul>
        {/* source: packages/brust/src/build/static-worker.ts:21-26 (_routes.json: the prefix, prefix/*, and the deploy inputs) */}
        <li>
          <code>_routes.json</code> lists the prefix and the deploy inputs only, so pages and assets never invoke the Worker.
        </li>
        {/* source: packages/brust/src/build/static-worker.ts:28-49 (the Worker: prefix -> the core; deploy inputs -> 404; anything else -> env.ASSETS) */}
        <li>
          The Worker sends the prefix to your actions and anything else that reaches it to the static files. The deploy inputs themselves (<code>_worker.js</code>, <code>_routes.json</code>, <code>.assetsignore</code>) are a 404 and are never served.
        </li>
        {/* source: docs/cloudflare.md §6 and §12 (admission still runs in Rust: method gate, body cap, Content-Encoding, the cross-site guard) */}
        <li>Admission still runs in Rust, exactly as on Workers: method gate, body cap, <code>Content-Encoding</code>, the cross-site guard with its 403.</li>
        {/* source: packages/brust/src/build/static-worker.ts:61-70 (ssg-actions-cache) and docs/cloudflare.md §12 (ttl_seconds and the L1 cache do not apply) */}
        <li>
          A <code>[cache]</code> adapter that needs a Cloudflare binding (KV, Durable Object) fails with <code>ssg-actions-cache</code>: the pages are files and the Worker serves actions only.
        </li>
        {/* source: docs/static.md §8 (Cloudflare Pages only; do not point Workers Static Assets at it) */}
        <li>
          This output is for Cloudflare Pages only. Do not point Workers Static Assets at it.
        </li>
      </ul>
      {/* source: docs/cloudflare.md §12 (deploy from dist/, where the project file names the output directory; secrets and bindings are yours) and packages/brust/src/build/static-worker.ts:52-58 */}
      <p>
        Deploy from <code>dist/</code>, where the project file is. It carries no bindings and no secrets: set those with <code>wrangler pages secret put</code> or the dashboard.
      </p>
      <CodeBlock code={blocks.pages.code} lang={blocks.pages.lang} cwd={blocks.pages.cwd} html={blocks.pages.html} />
      <Note>
        {/* source: docs/actions.md §11 (page-only builds and base_url for actions on their own domain) */}
        To keep the actions on their own domain instead, build the pages with <code>[actions] base_url</code> and the actions with <code>--actions-only</code>: see <a href="/docs/actions#separate">Actions on their own origin</a>.
      </Note>

      <h2 id="workers">Cloudflare Workers</h2>
      <p>The template has the two scripts; deploying needs <code>wrangler login</code> or an API token.</p>
      <CodeBlock code={blocks.cf.code} lang={blocks.cf.lang} cwd={blocks.cf.cwd} html={blocks.cf.html} />
      <ul>
        <li>
          <code>[server]</code> and <code>[workers]</code> do not apply on Workers; the build warns and ignores them.
        </li>
        <li>
          <code>bun:*</code> imports fail with <code>cf-unsupported</code>; swap them with <code>[cloudflare.alias]</code>.
        </li>
        <li>
          <code>cache.invalidate</code> reaches one isolate unless a cache adapter broadcasts it. No gzip in the Worker (Cloudflare compresses at the edge), no streaming HTML.
        </li>
      </ul>
      <Note>
        The full Workers guide, with D1 and the cache on KV and Durable Objects, is in <a href="/docs/cloudflare/workers">Cloudflare</a>.
      </Note>
    </>
  )
}
