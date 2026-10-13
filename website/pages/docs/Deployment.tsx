// Deployment — the Bun server (what to ship, how to run and supervise it) and Cloudflare Workers.
import CodeBlock from '../../components/CodeBlock'
import Note from '../../components/docs/Note'
import SwitchPanels from '../../components/demos/SwitchPanels'
import { type CodeBlockData, codeBlock } from '../../lib/highlight'
import type { TocItem } from '../../lib/nav'

export interface DeploymentData {
  toc: TocItem[]
  blocks: Record<'native' | 'cf', CodeBlockData>
  panels: { id: string; tab: string; note: string; text: string }[]
}

export async function deploymentLoader(): Promise<DeploymentData> {
  return {
    toc: [
      { id: 'pick', title: 'Pick a target' },
      { id: 'bun', title: 'The Bun server' },
      { id: 'workers', title: 'Cloudflare Workers' },
    ],
    blocks: {
      native: codeBlock({ lang: 'sh', cwd: '/srv/pokedex', code: '$ bun install --production\n$ bun run build\n$ BRUST_ADDR=0.0.0.0 BRUST_PORT=8080 bun dist/index.js' }),
      cf: codeBlock({ lang: 'sh', cwd: '~/pokedex', code: '$ bun run dev:cf\n$ bun run deploy:cf' }),
    },
    panels: [
      {
        id: 'bun',
        tab: 'Bun server',
        note: 'One process: Rust serves HTTP, Bun workers run your code. Needs Bun on the host, no Rust toolchain.',
        text: '$ bun run build\n$ BRUST_PORT=8080 bun dist/index.js\n[brust] listening on 127.0.0.1:8080 (io: hyper(tokio))\n[brust] ready (10 workers)',
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
      <p className="lead">The same app runs as one Bun process on your own machine, or as a Cloudflare Worker.</p>

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
