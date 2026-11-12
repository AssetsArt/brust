// Configuration — brust.toml sections, environment variables, precedence; configuring from code with run(); the response-size limits; a live builder for the pokedex's file.
// Every factual claim below has a `source:` comment next to it (file:line at this repo's v2 as of 2.0.0-alpha.3); lines marked "observed" were run, not read.
import CodeBlock from '../../components/CodeBlock'
import Note from '../../components/docs/Note'
import ConfigBuilder from '../../components/demos/ConfigBuilder'
import { type CodeBlockData, codeBlock } from '../../lib/highlight'
import type { TocItem } from '../../lib/nav'
import Frame from '../../components/docs/Frame'
import Lead from '../../components/docs/Lead'

export interface ConfigurationData {
  toc: TocItem[]
  blocks: Record<'server' | 'code' | 'cors' | 'build' | 'cache' | 'oversize' | 'oversizeLog', CodeBlockData>
}

const SERVER = `[server]
address = "127.0.0.1"   # default localhost
port = 1337             # 1..65535, default 1337
max_loader_response_bytes = 8388608   # 256 KiB..64 MiB, default 8 MiB (env BRUST_MAX_LOADER_RESPONSE_BYTES)
base_path = "/portal"   # mount the app under a path (a build setting), default the root
trailing_slash = "redirect"   # "strict" | "redirect" | "ignore" (a build setting), default "strict"
stats = "token"         # who may read /_brust/cache/stats: "off" (default), "public" or "token"
stats_token = "env:STATS_TOKEN"   # with stats = "token": the variable that holds the bearer token

[workers]
count = 4               # 1..1024, default one per CPU core
slot_bytes = 262144     # 64 KiB..16 MiB, default 256 KiB (env BRUST_SLOT_BYTES)`

// source: packages/brust/src/run.ts:15-21 (RunOptions: distDir, entry, config), :56 and :65 (defaults 'dist', 'routes.tsx'), config.ts:23-37 (the config fields),
// config.ts:49 (host/port/timeout defaults), :81-83 (workers, renderSlots defaults), :109-121 (ranges for values passed from code);
// slotBytes and maxLoaderResponseBytes: config.ts:39-43 (fields, env names), :65 (defaults), :77 and :80 (ranges), :179 and :195 (the toml keys).
const CODE = `// server.ts: run it with 'bun server.ts' after 'brust build'
import { run } from '@brust/core'

await run({
  distDir: 'dist',          // default 'dist'
  entry: 'routes.tsx',      // the routes module; default 'routes.tsx'
  config: {
    host: '127.0.0.1',      // default 'localhost'
    port: 8080,             // 0..65535 (0 = any free port); default 1337
    workers: 4,             // 1..1024; default one per CPU core
    renderSlots: 4,         // 1..64 per worker; default min(cores, 16)
    ioThreads: 4,           // 1..256 Rust I/O threads; default one per core
    callTimeoutMs: 30_000,  // a call still running after this answers 504
    drainTimeoutMs: 10_000, // how long a graceful shutdown waits
    bootTimeoutMs: 30_000,  // start waits this long for every worker
    slotBytes: 262_144,     // one render slot's shared buffer; 64 KiB..16 MiB, default 256 KiB
    maxLoaderResponseBytes: 8_388_608, // a bigger loader reply crosses by heap up to this; 256 KiB..64 MiB, default 8 MiB
  },
})`

// observed: a loader returning a 300,000-byte string on 2.0.0-alpha.3 with the settings above (workers 2, renderSlots 2): the client got this status line, the server logged the next block.
const OVERSIZE = `$ curl -si http://127.0.0.1:8080/big | head -1
HTTP/1.1 500 Internal Server Error`
const OVERSIZE_LOG = 'ERROR loader threw route=r1 error=response too large: 300029 > 262144'

const CORS = `[cors]
origins = ["https://pokedex.example"]   # required, at least one
methods = ["GET", "POST"]
headers = ["content-type"]
expose_headers = []
credentials = false                     # true with origin "*" is an error
max_age_seconds = 600`

const BUILD = `[build]
server_only = ["lib/db", "bun:sqlite"]   # import prefixes or app-relative paths kept out of the browser
source_roots = ["../shared"]             # monorepo: directories beside the app that relative imports may reach`

const CACHE = `[cache]
adapter = "redis"                 # redis | dragonfly | cloudflare-kv | cloudflare-do | custom

[cache.redis]
url = "env:REDIS_URL"             # always an env reference, never a literal URL`

export async function configurationLoader(): Promise<ConfigurationData> {
  return {
    toc: [
      { id: 'where', title: 'Where settings come from' },
      { id: 'server', title: 'Server and workers' },
      { id: 'code', title: 'Configure from code' },
      { id: 'toml-only', title: 'What only brust.toml sets' },
      { id: 'trailing-slash', title: 'Trailing slashes' },
      { id: 'base-path', title: 'Mount under a path' },
      { id: 'stats', title: 'The cache stats endpoint' },
      { id: 'try', title: 'Try it' },
      { id: 'size', title: 'Response size' },
      { id: 'env', title: 'Environment variables' },
      { id: 'other', title: 'The other sections' },
    ],
    blocks: {
      server: codeBlock({ lang: 'toml', file: 'brust.toml', code: SERVER }),
      code: codeBlock({ lang: 'ts', file: 'server.ts', code: CODE }),
      cors: codeBlock({ lang: 'toml', file: 'brust.toml', code: CORS }),
      build: codeBlock({ lang: 'toml', file: 'brust.toml', code: BUILD }),
      cache: codeBlock({ lang: 'toml', file: 'brust.toml', code: CACHE }),
      oversize: codeBlock({ lang: 'sh', cwd: '~/my-app', code: OVERSIZE }),
      oversizeLog: codeBlock({ lang: 'text', cwd: 'server log', code: OVERSIZE_LOG }),
    },
  }
}

export default function Configuration({ blocks }: ConfigurationData) {
  return (
    <>
      <h1>Configuration</h1>
      <Lead>One optional file, brust.toml, next to package.json. Every key has a default; a missing file is fine, a malformed one stops the server with a message.</Lead>

      <h2 id="where">Where settings come from</h2>
      {/* source: packages/brust/src/config.ts:1-9 (precedence comment) and :79-87 (env ?? cli ?? toml ?? default per field); an empty env var is unset: :195; cli.ts:115-121 (`brust start` passes only --port and --workers) */}
      <p>
        For <code>brust start</code>, an environment variable beats a command-line flag, a flag beats <code>brust.toml</code>, and <code>brust.toml</code> beats the default. An empty variable counts as unset. When you start the server
        from your own file with <code>run()</code>, the <code>config</code> you pass takes the place of the flags: environment, then <code>run({'{ config }'})</code>, then <code>brust.toml</code>, then the defaults.
      </p>

      <h2 id="server">Server and workers</h2>
      <CodeBlock code={blocks.server.code} lang={blocks.server.lang} file={blocks.server.file} html={blocks.server.html} />
      {/* source: packages/brust/src/config.ts:131-151 (the [server] and [workers] keys and their ranges); worker threads: run.ts:114-120; Rust I/O threads default one per core: config.ts:33-34 */}
      <p>Each worker is a Bun thread that runs loaders, jobs and actions. Rust handles HTTP on its own threads, one per core by default.</p>

      <h2 id="code">Configure from code</h2>
      {/* source: packages/brust/src/cli.ts:115-121 — `brust start` forwards only port and workers, so the other settings need env vars or run() */}
      <p>
        <code>brust start</code> takes <code>--port</code>, <code>--workers</code>, <code>--dist-dir</code> and <code>--entry</code>, and nothing else. To set the rest without environment variables, call <code>run()</code> from your own file.
      </p>
      <CodeBlock code={blocks.code.code} lang={blocks.code.lang} file={blocks.code.file} html={blocks.code.html} />
      {/* source: packages/brust/src/run.ts:54-70 — run() reads dist/manifest.json, loads brust.toml from the working directory, and starts the server */}
      <p>
        Build first with <code>brust build</code>, then start with <code>bun server.ts</code>. <code>run()</code> still reads <code>brust.toml</code> from the current directory, and an environment variable still wins over the value you pass.
        A value outside its range stops the start with a message that names it.
      </p>
      {/* source: packages/brust/src/run.ts:7-8 — nothing in run() returns on its own; every exit is an explicit process.exit */}
      <p>Once the server is up, <code>run()</code> does not return; the process lives until a signal drains it.</p>

      <h2 id="toml-only">What only brust.toml sets</h2>
      {/* source: packages/brust/src/config.ts:35,88,153 — [cors] reaches the config from brust.toml only; a `cors` passed through run({'{ config }'}) is not read (loadConfig builds the result without cli.cors) */}
      <p>
        <code>[cors]</code> is read when the server starts, from <code>brust.toml</code> only. The <code>config</code> object of <code>run()</code> has no effect on it today.
      </p>
      {/* source: packages/brust/src/build/config.ts:274-277 (loadBuildConfig: no brust.toml = no actions, no cache), build/index.ts:94 (read by `brust build`), run.ts:23-28 and :40-42 (the server takes both from dist/manifest.json) */}
      <p>
        <code>[actions]</code>, <code>[cache]</code> and <code>[build]</code> are read by <code>brust build</code> and recorded in the manifest, so they are decided at build time. A build with no <code>brust.toml</code> has no actions and no
        shared cache, whatever <code>server.ts</code> says.
      </p>

      <h2 id="trailing-slash">Trailing slashes</h2>
      {/* source: packages/brust/src/config.ts:87 (checkTrailingSlash: the three values) and :254 (the toml key), crates/brust-core/src/config.rs:441 (TrailingSlash::strip: `/` and a %2F are not trailing slashes), crates/brust-core/src/pipeline.rs:173-209 (the step: after brust's own paths and the method gate, before matching and the page cache), packages/brust/src/run.ts:110 (trailing-slash-mismatch), packages/brust/src/build/static.ts:183 (the static warning), crates/brust-server/tests/trailing_slash.rs (served) */}
      <p>
        <code>[server] trailing_slash</code> decides what a page request whose path ends in <code>/</code> gets. <code>"strict"</code>, the default, is the behaviour you had: the path is matched as written, so <code>/cart/</code> is a 404 next to
        a <code>/cart</code> route. <code>"redirect"</code> answers a GET or HEAD with <strong>308</strong> to the same path without the slash, the query string kept and the base path too (<code>/portal/</code> goes to <code>/portal</code>), before
        any route is matched or the page cache read. <code>"ignore"</code> drops the slash before matching: both spellings answer the same page from one cache entry. Other methods, <code>/</code> itself, a path ending in <code>%2F</code>, and
        brust&rsquo;s own paths (<code>/_brust/…</code>, <code>/public/…</code>, <code>/ping</code>) are never touched.
      </p>
      <p>
        Like <code>base_path</code>, it is baked into the manifest by <code>brust build</code>; a <code>brust.toml</code> or <code>run({'{ config: { trailingSlash } }'})</code> that names another value stops <code>brust start</code> with 
        <code>trailing-slash-mismatch</code>. With <code>--target static</code> the static host serves the files its own way: the build warns <code>trailing-slash-static</code> unless the value is <code>"strict"</code>.
      </p>

      <h2 id="base-path">Mount under a path</h2>
      {/* source: packages/brust/src/config.ts:59-70 (normalizeBasePath: the accepted shape) and :202-205 (the toml key), packages/brust/src/build/config.ts:408-415 (read by brust build, a bad value is a build error) and :288-297 (the default actions prefix moves under it), packages/brust/src/run.ts:86-92 (base-path-mismatch) */}
      <p>
        Two brust apps can share one origin when each one is mounted under its own path. Set <code>[server] base_path = "/portal"</code> and the app answers under <code>/portal</code> only. The value starts with <code>/</code>, has no trailing{' '}
        <code>/</code>, and each segment is letters, digits, <code>.</code>, <code>_</code>, <code>~</code> or <code>-</code>. Absent, empty or <code>"/"</code> is the root, and the build is the one you had before.
      </p>
      {/* source: crates/brust-core/src/pipeline.rs:109-125 (a request outside the base is a plain 404; the framework paths are matched below it), crates/brust-core/src/render.rs:432-440 and :944-956 (the stylesheet, script and nav tags carry the base), packages/brust/src/build/cf-assets.ts:40-47 (the Cloudflare and static asset tree sits under it) */}
      <p>
        It is a <em>build</em> setting: <code>brust build</code> bakes it into <code>dist/manifest.json</code>, and the server answers under the base the manifest names. A <code>brust.toml</code> (or <code>run({'{ config: { basePath } }'})</code>) that names
        another one stops <code>brust start</code> with <code>base-path-mismatch</code>: rebuild. With none set, the manifest's wins.
      </p>
      <p>
        Every URL brust owns moves below the base: <code>/portal/_brust/client/…</code> (scripts, stylesheets, islands, fonts and images the bundles import), <code>/portal/_brust/action/…</code> (the default actions prefix; an explicit{' '}
        <code>[actions] prefix</code> is used as written and has to lie under the base), <code>/portal/_brust/cache/stats</code>, <code>/portal/public/…</code> and <code>/portal/ping</code>. A path outside the base is a plain 404 from this app: it belongs to
        another one on the same origin. The routes, your links, <code>navigate()</code> and <code>redirect()</code> keep writing real URL paths, with the base: see <a href="/docs/routing">Routing</a>.
      </p>
      {/* source: packages/brust/src/index.ts:6-11 (basePath on the server), packages/brust/src/browser.ts (basePath in the browser, from the page's __BRUST_BASE_PATH__), packages/runtime-dom/src/nav/nav.ts:27-30 (a link outside the base is a full page load) */}
      <p>
        <code>import {'{ basePath }'} from '@brust/core'</code> gives the value (<code>''</code> at the root) on the server and in the browser, for code that builds URLs of its own. Read it inside your app's modules (routes, components, loaders), not in the file that calls <code>run()</code>: that file loads before the manifest's value is known. On Cloudflare the build bakes it into the Worker. A link to a path outside the base is a full page load, never a swapped
        fetch, so the app's SPA navigation stays inside its own subtree. To run two apps on one machine, see <a href="/docs/deployment">Deployment</a>.
      </p>

      <h2 id="try">Try it</h2>
      <p>Set the pokedex server's port, worker count and actions; the file and the one-run override follow.</p>
      <Frame title="Live demo" label="ConfigBuilder · native">
          <ConfigBuilder />
        
      </Frame>

      <h2 id="size">Response size</h2>
      {/* source: packages/brust/src/worker.ts:102 (SLOT_BYTES = 256 * 1024) and packages/brust/src/run.ts:115-118 (one SharedArrayBuffer of SLOT_BYTES * renderSlots per worker) */}
      <p>
        Every render slot is a 256 KiB shared buffer, and each worker has <code>renderSlots</code> of them. Memory for them is 256 KiB × render slots × workers: 4 workers with 4 slots each is 4 MiB.
      </p>
      {/* source: packages/brust/src/worker.ts:24-37 (writeSlot swaps an oversized response for {"error":"response too large: <n> > <slot>"}) and :71 (every call kind goes through it); the status and the log line below were observed */}
      <p>
        A loader or job response has to fit its slot. The size counted is the JSON the loader or job returns (the page props and the job results), in UTF-8 bytes, not the HTML. One that does not fit fails the request with a plain 500, and the
        server's log carries the reason.
      </p>
      <CodeBlock code={blocks.oversize.code} lang={blocks.oversize.lang} cwd={blocks.oversize.cwd} html={blocks.oversize.html} />
      <CodeBlock code={blocks.oversizeLog.code} lang={blocks.oversizeLog.lang} cwd={blocks.oversizeLog.cwd} html={blocks.oversizeLog.html} />
      {/* source: packages/brust/src/config.ts has no slot-size setting; SLOT_BYTES is a constant (worker.ts:102) */}
      <p>The slot size is not configurable yet. Keep what a loader returns small: return what the page renders, and fetch the rest from an action.</p>
      {/* source: docs/actions.md:426 (8 MiB default, heap transfer, the 500 text), packages/brust/src/actions/prefix.ts:3-4 (defaults 1 MiB and 8 MiB), packages/brust/src/actions-bridge.ts:25-43 (heap transfer of what does not fit the slot) */}
      <Note>
        Actions are different. An action body larger than the slot crosses by heap transfer, up to <code>[actions] max_response_bytes</code> (8 MiB by default); a bigger one is a 500 with{' '}
        <code>brust: action response exceeds &lt;max_response_bytes&gt; bytes</code>. Request bodies are capped by <code>max_body_bytes</code> (1 MiB by default).
      </Note>

      <h2 id="stats">The cache stats endpoint</h2>
      {/* source: crates/brust-core/src/pipeline.rs:137-140 (the path is the app's own only for a request that may read it; any other gets an unknown path's answer) and :154-160 (the 200 carries cache-control: no-store, once, for every host; crates/brust-core/tests/stats_no_store.rs:121 asserts it in both modes) and crates/brust-core/src/config.rs:468 (StatsAccess: off, public, token; the bearer compared in constant time); packages/brust/src/run.ts:62 (the default: off, public under brust dev; the token is read from its env variable at boot);
          tests: crates/brust-server/tests/stats_gate.rs:24 (off, public, token right and wrong, 404 and no challenge), packages/brust/test/napi-server.test.ts:224 (the same through the real addon), packages/brust/test/run-options.test.ts:52 (defaults and the env token), packages/brust/test/config.test.ts:135 (toml, env, errors) */}
      <p>
        <code>/_brust/cache/stats</code> reports cache sizes, hit rates and loader, job and worker call counts. It is <strong>off</strong> by default: the path answers 404, like any path nothing serves, so an app behind an edge that forwards every path does not
        publish its metrics on every domain it serves. <code>[server] stats</code> opens it: <code>"public"</code> serves the JSON to anyone, <code>"token"</code> serves it to a request with <code>Authorization: Bearer &lt;token&gt;</code> and answers 404 (not 401, so the
        endpoint is not revealed) to a wrong or missing one. A response that is served always carries <code>cache-control: no-store</code>, so an edge that caches everything does not keep it. <code>brust dev</code> defaults to <code>"public"</code>. <code>/ping</code> stays public in every mode.
      </p>
      <p>
        The token is never written in a file: <code>stats_token = "env:NAME"</code> names the variable that holds it, and <code>brust start</code> stops with a message naming the variable when it is unset or empty. The environment variable{' '}
        <code>BRUST_STATS</code> sets the mode too (it wins over the file); <code>run({'{ config: { stats, statsToken } }'})</code> sets both from code. If you monitor an app with this endpoint, set <code>stats = "public"</code> or <code>"token"</code> when you upgrade. Workers has
        its own switch, <code>[cloudflare] stats</code>, and ignores <code>[server]</code>.
      </p>

      <h2 id="env">Environment variables</h2>
      <table>
        <thead>
          <tr>
            <th>Variable</th>
            <th>Range</th>
            <th>Also in brust.toml</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>BRUST_ADDR</code>
            </td>
            <td>non-empty</td>
            <td>
              <code>[server] address</code>
            </td>
          </tr>
          <tr>
            <td>
              <code>BRUST_PORT</code>
            </td>
            <td>1 to 65535</td>
            <td>
              <code>[server] port</code>
            </td>
          </tr>
          <tr>
            <td>
              <code>BRUST_WORKERS</code>
            </td>
            <td>1 to 1024</td>
            <td>
              <code>[workers] count</code>
            </td>
          </tr>
          <tr>
            <td>
              <code>BRUST_RENDER_SLOTS</code>
            </td>
            <td>1 to 64 (default: cores, at most 16)</td>
            <td>no</td>
          </tr>
          <tr>
            <td>
              <code>BRUST_WORKER_THREADS</code>
            </td>
            <td>1 to 256 Rust I/O threads (default: one per core)</td>
            <td>no</td>
          </tr>
          <tr>
            <td>
              <code>BRUST_BOOT_TIMEOUT_MS</code>
            </td>
            <td>default 30000</td>
            <td>no</td>
          </tr>
          <tr>
            <td>
              <code>BRUST_CALL_TIMEOUT_MS</code>
            </td>
            <td>default 30000</td>
            <td>no</td>
          </tr>
          <tr>
            <td>
              <code>BRUST_DRAIN_TIMEOUT_MS</code>
            </td>
            <td>default 10000</td>
            <td>no</td>
          </tr>
          <tr>
            <td>
              <code>BRUST_STATS</code>
            </td>
            <td>off, public or token</td>
            <td>
              <code>[server] stats</code>
            </td>
          </tr>
          <tr>
            <td>
              <code>BRUST_DIST_DIR</code>, <code>BRUST_APP_ENTRY</code>
            </td>
            <td>paths</td>
            <td>
              no (flags <code>--dist-dir</code>, <code>--entry</code>)
            </td>
          </tr>
        </tbody>
      </table>

      <h2 id="other">The other sections</h2>
      <p>
        <code>[actions]</code> turns actions on; see <a href="/docs/actions">Actions</a>. <code>[cors]</code> is read from the file only:
      </p>
      <CodeBlock code={blocks.cors.code} lang={blocks.cors.lang} file={blocks.cors.file} html={blocks.cors.html} />
      <p>
        <code>[csp]</code> sends a Content-Security-Policy header with every page (off by default); see <a href="/docs/csp">Content Security Policy</a>.
      </p>
      <p>
        <code>[build] server_only</code> names modules that must never reach the browser; reaching one from client code fails the build with <code>server-only-in-client</code>.
      </p>
      <CodeBlock code={blocks.build.code} lang={blocks.build.lang} file={blocks.build.file} html={blocks.build.html} />
      <p>
        <code>[build] source_roots</code> lists directories outside the app, relative to the app root, that its relative imports may reach: in a monorepo, <code>import Button from &quot;../shared/Button&quot;</code> compiles when <code>../shared</code> is listed. Without it brust reads only the app&rsquo;s own directory, and the import fails the build with <code>unresolved-import</code> (&ldquo;it leaves the app root&rdquo;). Each entry must be an existing directory; <code>..</code> chains are normalised. The check is on the path as written, so an import that climbs out of a listed directory (<code>../shared/../secret</code>) is refused as well. Symbolic links are not followed when checking.
      </p>
      <p>
        <code>[cache]</code> configures a shared cache adapter (see <a href="/docs/cache-adapters/overview">Cache adapters</a>), and <code>[cloudflare]</code> the Workers target (see <a href="/docs/cloudflare/workers">Workers target</a>).
      </p>
      <CodeBlock code={blocks.cache.code} lang={blocks.cache.lang} file={blocks.cache.file} html={blocks.cache.html} />
      <Note>
        <code>brust start</code> has no TLS option. Put a proxy or a load balancer in front of it for HTTPS.
      </Note>
    </>
  )
}
