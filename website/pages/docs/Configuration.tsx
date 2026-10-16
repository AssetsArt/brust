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
