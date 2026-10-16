// CLI — brust build, brust start, brust dev: flags, output, exit codes; the demo switches between real outputs.
// Every flag below is checked against packages/brust/src/cli.ts (the parseArgs table at :46-63 and the usage text at :10-20); the long explanations live on the Dev mode, Actions, Deployment and Cloudflare pages.
import CodeBlock from '../../components/CodeBlock'
import Note from '../../components/docs/Note'
import SwitchPanels from '../../components/demos/SwitchPanels'
import { type CodeBlockData, codeBlock } from '../../lib/highlight'
import type { TocItem } from '../../lib/nav'
import Frame from '../../components/docs/Frame'
import Lead from '../../components/docs/Lead'

export interface CliData {
  toc: TocItem[]
  blocks: Record<'usage', CodeBlockData>
  panels: { id: string; tab: string; note: string; text: string }[]
}

// source: packages/brust/src/cli.ts:10-14 (the usage text, verbatim)
const USAGE = `usage:
  brust build [entry=routes.tsx] [--out-dir dist] [--force] [--target bun|cloudflare|static] [--actions-only] [--strict] [--wasm-from-source] [--dev]
  brust dev [entry=routes.tsx] [--port N] [--workers N]    (Bun target: proxy + hot reload + inline TUI)
  brust dev [entry=routes.tsx] --target cloudflare [--out-dir dist] [--port N] [--wasm-from-source] [-- <wrangler args>]
  brust start [--port N] [--workers N] [--dist-dir dist] [--entry routes.tsx]
  brust shadcn init [component ...] [--force] [--css <file>] [--base-color <name>] [--shadcn-version <x.y.z>]`

export async function cliLoader(): Promise<CliData> {
  return {
    toc: [
      { id: 'usage', title: 'The commands' },
      { id: 'run', title: 'What they print' },
      { id: 'build', title: 'brust build' },
      { id: 'start', title: 'brust start' },
      { id: 'dev', title: 'brust dev' },
      { id: 'flags', title: 'Every flag' },
    ],
    blocks: { usage: codeBlock({ lang: 'text', file: 'brust --help', code: USAGE }) },
    panels: [
      {
        id: 'build',
        tab: 'brust build',
        note: 'The pokedex example. Each React fallback prints once, with its rule and line.',
        text: '$ brust build routes.tsx\nwarning hook-unsupported components/TeamBuilder.tsx:12:3 hook useTransition is not supported\nwarning hook-unsupported components/UnifiedIsland.tsx:11:3 hook useTransition is not supported\n[brust] built dist in 73ms',
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
        note: 'Plain output (a pipe or CI), recorded on the blank template: one page edit, then a stylesheet edit.',
        text: '$ brust dev routes.tsx --port 4873\n[brust] dev server on http://127.0.0.1:4873 — [r]eload  [o]pen  [w]arnings  [c]lear  [q]uit\n[brust] building http://127.0.0.1:4873 gen 0\n[brust] ready http://127.0.0.1:4873 gen 1 (55ms)\n[brust] building http://127.0.0.1:4873 gen 1 (55ms)\n[brust] ready http://127.0.0.1:4873 gen 2 (46ms)\n[brust] css public/app.css (no reload)',
      },
    ],
  }
}

export default function Cli({ blocks, panels }: CliData) {
  return (
    <>
      <h1>CLI</h1>
      <Lead>Three commands: build compiles the app into dist/, start serves it, dev rebuilds and reloads while you edit.</Lead>

      <h2 id="usage">The commands</h2>
      <CodeBlock code={blocks.usage.code} lang={blocks.usage.lang} file={blocks.usage.file} html={blocks.usage.html} />
      <p>
        Exit codes: <code>0</code> on success, <code>1</code> for a build or boot error, <code>2</code> for a usage error.
      </p>

      <h2 id="run">What they print</h2>
      <p>Real output, from the pokedex example and from this site's own build.</p>
      <Frame title="Live demo" label="SwitchPanels · native">
          <SwitchPanels label="Commands" panels={panels} />
        
      </Frame>

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
      {/* source: packages/brust/src/cli.ts:104-123 (no --target or --target bun or static: the Bun dev server; --target cloudflare: the wrangler loop) and packages/brust/src/dev/bun.ts:1-4 */}
      <p>
        <code>brust dev</code> is the development server for the Bun target. It rebuilds when you save, boots the new build beside the old one and swaps it in, and shows build errors above the last good page. It takes an entry, <code>--port</code> and{' '}
        <code>--workers</code>. The whole loop, the terminal keys, the browser overlay and the dev trace are on the <a href="/docs/dev-mode">Dev mode</a> page.
      </p>
      {/* source: packages/brust/src/cli.ts:109 — arguments after `--` are refused unless --target cloudflare */}
      <p>
        <code>brust dev --target cloudflare</code> builds, runs <code>wrangler dev</code>, watches the app and rebuilds on a change (no hot reload). A failed rebuild keeps the running Worker. Arguments after <code>--</code> go to wrangler, and the Bun dev server
        refuses them.
      </p>

      <h2 id="flags">Every flag</h2>
      <table>
        <thead>
          <tr>
            <th>Flag</th>
            <th>Commands</th>
            <th>What it does</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>--out-dir</code>
            </td>
            <td>build, dev (cloudflare)</td>
            <td>
              {/* source: cli.ts:50 and :86 (default `dist`) */}
              Where the build is written. Default <code>dist</code>.
            </td>
          </tr>
          <tr>
            <td>
              <code>--force</code>
            </td>
            <td>build, shadcn init</td>
            <td>
              {/* source: cli.ts:55 and :87; the out-dir rules are described above (out-dir-unsafe) */}
              build: writes into an out dir that is not empty and was not made by brust. shadcn init: replaces an existing <code>components.json</code> and runs the theme step again.
            </td>
          </tr>
          <tr>
            <td>
              <code>--target bun|cloudflare|static</code>
            </td>
            <td>build, dev</td>
            <td>
              {/* source: cli.ts:73-75 (the three values; anything else is a usage error), docs/static.md:1-7 (static: the normal dist/ plus every page rendered to dist/static/), docs/cloudflare.md (cloudflare: dist/cf) */}
              <code>bun</code> is the default. <code>cloudflare</code> also writes <code>dist/cf/</code>, a Worker for wrangler. <code>static</code> also renders every page to files in <code>dist/static/</code> that you can upload to Cloudflare Pages
              (see <a href="/docs/deployment">Deployment</a>).
            </td>
          </tr>
          <tr>
            <td>
              <code>--strict</code>
            </td>
            <td>build --target static</td>
            <td>
              {/* source: cli.ts:77 (only with `build --target static`, otherwise a usage error) and docs/static.md:7 (a loader that reads the request fails the build) */}
              A loader that reads the request (headers, cookies, query) fails the build instead of rendering the page a visitor with none of those would see.
            </td>
          </tr>
          <tr>
            <td>
              <code>--actions-only</code>
            </td>
            <td>build</td>
            <td>
              {/* source: cli.ts:76 (build only) and docs/actions.md:439-441 (no pages: no routes, templates, jobs or client chunks; `prefix = "/"` allowed), docs/cloudflare.md:144 (with --target cloudflare: a Worker that serves only actions) */}
              Builds only the <code>[actions]</code> app, with no pages. It combines with <code>--target bun</code> (the default) and <code>--target cloudflare</code>. See <a href="/docs/actions">Actions</a>.
            </td>
          </tr>
          <tr>
            <td>
              <code>--dev</code>
            </td>
            <td>build</td>
            <td>
              {/* source: cli.ts:60 and :92 and packages/brust/src/build/index.ts:99-103 (`brust build --dev`: also writes dev.json and builds the client runtime with __BRUST_DEV__); `brust dev` passes it itself, bun.ts:168 */}
              Also writes <code>dev.json</code> and builds the client runtime for dev. <code>brust dev</code> passes it for you; you rarely type it.
            </td>
          </tr>
          <tr>
            <td>
              <code>--wasm-from-source</code>
            </td>
            <td>build, dev (cloudflare)</td>
            <td>
              {/* source: cli.ts:58 and :90 and :120 */}
              Builds the Cloudflare wasm host from the repository's Rust source instead of using the published package.
            </td>
          </tr>
          <tr>
            <td>
              <code>--port</code>, <code>--workers</code>
            </td>
            <td>start, dev</td>
            <td>
              {/* source: cli.ts:53-54 and :106-110 (dev) and :132-133 (start); `--port 0` picks a free port (intFlag at :27-33) */}
              The port (<code>0</code> picks a free one) and the number of Bun workers.
            </td>
          </tr>
          <tr>
            <td>
              <code>--dist-dir</code>, <code>--entry</code>
            </td>
            <td>start</td>
            <td>
              {/* source: cli.ts:51-52 and :135-136 */}
              Which built folder to serve and which routes module to load. Defaults <code>dist</code> and <code>routes.tsx</code>.
            </td>
          </tr>
                  <tr>
            <td>
              <code>--css</code> <code>--base-color</code> <code>--shadcn-version</code>
            </td>
            <td>shadcn init</td>
            <td>
              The Tailwind entry CSS (default: the one top-level <code>app.css</code>-style file that imports <code>tailwindcss</code>), the shadcn base colour (default <code>neutral</code>) and an exact shadcn CLI version (default: the one brust tests). See <a href="/docs/guides/shadcn-setup">Set up shadcn/ui</a>.
            </td>
          </tr>
</tbody>
      </table>
      {/* source: docs/actions.md:472 — a page-only build is not a flag: `[actions] base_url` in brust.toml and no actions file */}
      <Note>
        A <em>page-only</em> build (pages that call actions on another origin) has no flag. It is what <code>brust build</code> does when <code>brust.toml</code> sets <code>[actions] base_url</code> and the project has no actions file.
      </Note>
    </>
  )
}
