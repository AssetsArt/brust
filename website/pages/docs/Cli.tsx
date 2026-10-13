// CLI — brust build, brust start, brust dev: flags, output, exit codes; the demo switches between real outputs.
import CodeBlock from '../../components/CodeBlock'
import Note from '../../components/docs/Note'
import SwitchPanels from '../../components/demos/SwitchPanels'
import { type CodeBlockData, codeBlock } from '../../lib/highlight'
import type { TocItem } from '../../lib/nav'

export interface CliData {
  toc: TocItem[]
  blocks: Record<'usage', CodeBlockData>
  panels: { id: string; tab: string; note: string; text: string }[]
}

const USAGE = `usage:
  brust build [entry=routes.tsx] [--out-dir dist] [--force] [--target bun|cloudflare] [--wasm-from-source]
  brust dev [entry=routes.tsx] --target cloudflare [--out-dir dist] [--port N] [--wasm-from-source] [-- <wrangler args>]
  brust start [--port N] [--workers N] [--dist-dir dist] [--entry routes.tsx]`

export async function cliLoader(): Promise<CliData> {
  return {
    toc: [
      { id: 'usage', title: 'The commands' },
      { id: 'run', title: 'What they print' },
      { id: 'build', title: 'brust build' },
      { id: 'start', title: 'brust start' },
      { id: 'dev', title: 'brust dev' },
    ],
    blocks: { usage: codeBlock({ lang: 'text', file: 'brust --help', code: USAGE }) },
    panels: [
      {
        id: 'build',
        tab: 'brust build',
        note: 'The pokedex example. Each React fallback prints once, with its rule and line.',
        text: '$ brust build routes.tsx\nwarning hook-unsupported components/TeamBuilder.tsx:12:26 hook useReducer is not supported\nwarning hook-unsupported components/UnifiedIsland.tsx:11:25 hook useReducer is not supported\n[brust] built dist in 73ms',
      },
      {
        id: 'start',
        tab: 'brust start',
        note: 'Ready once every worker has booted. Server log lines trimmed.',
        text: '$ brust start\n[brust] listening on 127.0.0.1:1337 (io: hyper(tokio))\n[brust] ready (10 workers)',
      },
      {
        id: 'nodist',
        tab: 'start before build',
        note: 'start needs a built dist/ (the absolute path in the message is shortened to ~ here).',
        text: '$ brust start\n[brust] run brust build first (~/pokedex/dist/manifest.json not found)',
      },
      {
        id: 'dev',
        tab: 'brust dev',
        note: 'dev is the Cloudflare development loop only, in this release.',
        text: '$ brust dev\nbrust dev: only --target cloudflare in this release',
      },
    ],
  }
}

export default function Cli({ blocks, panels }: CliData) {
  return (
    <>
      <h1>CLI</h1>
      <p className="lead">Three commands: build compiles the app into dist/, start serves it, dev runs the Cloudflare development loop.</p>

      <h2 id="usage">The commands</h2>
      <CodeBlock code={blocks.usage.code} lang={blocks.usage.lang} file={blocks.usage.file} html={blocks.usage.html} />
      <p>
        Exit codes: <code>0</code> on success, <code>1</code> for a build or boot error, <code>2</code> for a usage error.
      </p>

      <h2 id="run">What they print</h2>
      <p>Real output, from the pokedex example and from this site's own build.</p>
      <div className="browser">
        <div className="url">
          <span>Live demo</span>
          <span className="lbl">SwitchPanels · native</span>
        </div>
        <div className="vp">
          <SwitchPanels label="Commands" panels={panels} />
        </div>
      </div>

      <h2 id="build">brust build</h2>
      <ul>
        <li>
          Takes one entry, <code>routes.tsx</code> by default. A build error prints <code>error &lt;rule&gt; &lt;message&gt;</code> and exits 1.
        </li>
        <li>Writes to a temporary folder and swaps it in only on success.</li>
        <li>
          Refuses an out dir that is not empty and was not made by brust, unless you pass <code>--force</code>, and never writes to the app root, your home or a folder with sources (<code>out-dir-unsafe</code>).
        </li>
        <li>
          <code>--target cloudflare</code> also writes <code>dist/cf/</code>, a Worker ready for wrangler.
        </li>
      </ul>

      <h2 id="start">brust start</h2>
      <ul>
        <li>
          Serves the built <code>dist/</code>; it takes no entry argument. It sets <code>NODE_ENV=production</code> unless you set it.
        </li>
        <li>
          <code>SIGINT</code> or <code>SIGTERM</code> drain in-flight requests, then exit 0. A second signal exits at once.
        </li>
        <li>If a worker dies, the server drains and exits 1. It does not respawn workers: run it under a supervisor that restarts the process.</li>
      </ul>

      <h2 id="dev">brust dev</h2>
      <p>
        <code>brust dev --target cloudflare</code> builds, runs <code>wrangler dev</code>, watches the app and rebuilds on a change (no hot reload). A failed rebuild keeps the running Worker. Arguments after <code>--</code> go to wrangler.
      </p>
      <Note>
        For the Bun server there is no watch mode: <code>bun run dev</code> in the template is <code>brust build routes.tsx &amp;&amp; brust start</code>. Run it again after a change.
      </Note>
    </>
  )
}
