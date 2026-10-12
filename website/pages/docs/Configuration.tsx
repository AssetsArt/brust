// Configuration — brust.toml sections, environment variables, precedence; a live builder for the pokedex's file.
import CodeBlock from '../../components/CodeBlock'
import Note from '../../components/docs/Note'
import ConfigBuilder from '../../components/demos/ConfigBuilder'
import { type CodeBlockData, codeBlock } from '../../lib/highlight'
import type { TocItem } from '../../lib/nav'

export interface ConfigurationData {
  toc: TocItem[]
  blocks: Record<'server' | 'cors' | 'build' | 'cache', CodeBlockData>
}

const SERVER = `[server]
address = "127.0.0.1"   # default localhost
port = 1337             # 1..65535, default 1337

[workers]
count = 4               # 1..1024, default one per CPU core`

const CORS = `[cors]
origins = ["https://pokedex.example"]   # required, at least one
methods = ["GET", "POST"]
headers = ["content-type"]
expose_headers = []
credentials = false                     # true with origin "*" is an error
max_age_seconds = 600`

const BUILD = `[build]
server_only = ["lib/db", "bun:sqlite"]   # import prefixes or app-relative paths kept out of the browser`

const CACHE = `[cache]
adapter = "redis"                 # redis | dragonfly | cloudflare-kv | cloudflare-do | custom

[cache.redis]
url = "env:REDIS_URL"             # always an env reference, never a literal URL`

export async function configurationLoader(): Promise<ConfigurationData> {
  return {
    toc: [
      { id: 'where', title: 'Where settings come from' },
      { id: 'server', title: 'Server and workers' },
      { id: 'try', title: 'Try it' },
      { id: 'env', title: 'Environment variables' },
      { id: 'other', title: 'The other sections' },
    ],
    blocks: {
      server: codeBlock({ lang: 'toml', file: 'brust.toml', code: SERVER }),
      cors: codeBlock({ lang: 'toml', file: 'brust.toml', code: CORS }),
      build: codeBlock({ lang: 'toml', file: 'brust.toml', code: BUILD }),
      cache: codeBlock({ lang: 'toml', file: 'brust.toml', code: CACHE }),
    },
  }
}

export default function Configuration({ blocks }: ConfigurationData) {
  return (
    <section style={{ display: 'contents' }}>
      <h1>Configuration</h1>
      <p className="lead">One optional file, brust.toml, next to package.json. Every key has a default; a missing file is fine, a malformed one stops the server with a message.</p>

      <h2 id="where">Where settings come from</h2>
      <p>
        For <code>brust start</code>, an environment variable beats a command-line flag, a flag beats <code>brust.toml</code>, and <code>brust.toml</code> beats the default. An empty variable counts as unset.
      </p>

      <h2 id="server">Server and workers</h2>
      <CodeBlock code={blocks.server.code} lang={blocks.server.lang} file={blocks.server.file} html={blocks.server.html} />
      <p>Each worker is a Bun thread that runs loaders, jobs and actions. Rust handles HTTP on its own threads, one per core by default.</p>

      <h2 id="try">Try it</h2>
      <p>Set the pokedex server's port, worker count and actions; the file and the one-run override follow.</p>
      <div className="browser">
        <div className="url">
          <span>Live demo</span>
          <span className="lbl">ConfigBuilder · native</span>
        </div>
        <div className="vp">
          <ConfigBuilder />
        </div>
      </div>

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
        <code>[cache]</code> configures a shared cache adapter (see <a href="/docs/cache-adapters/overview">Cache adapters</a>), and <code>[cloudflare]</code> the Workers target (see <a href="/docs/cloudflare/workers">Workers target</a>).
      </p>
      <CodeBlock code={blocks.cache.code} lang={blocks.cache.lang} file={blocks.cache.file} html={blocks.cache.html} />
      <Note>
        <code>brust start</code> has no TLS option. Put a proxy or a load balancer in front of it for HTTPS.
      </Note>
    </section>
  )
}
