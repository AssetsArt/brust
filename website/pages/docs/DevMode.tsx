// Dev mode — `brust dev` for the Bun target: the proxy parent and its blue/green child, what reloads and what does not, the error overlay, the inline terminal UI,
// the <brust-devtools> overlay (Alt+Shift+B), the token-gated dev trace and dev.json; the demo steps the loop with five buttons.
// Every factual claim below has a `source:` comment next to it (file:line in this tree, which has v2 through the gaps round merged in); lines marked "observed" were run on 2026-10-13, not read.
import CodeBlock from '../../components/CodeBlock'
import Note from '../../components/docs/Note'
import DevLoopDemo from '../../components/demos/DevLoopDemo'
import { type CodeBlockData, codeBlock } from '../../lib/highlight'
import type { TocItem } from '../../lib/nav'
import Frame from '../../components/docs/Frame'
import Lead from '../../components/docs/Lead'

export interface DevModeData {
  toc: TocItem[]
  blocks: Record<'run' | 'plain' | 'tty' | 'ttyErr' | 'trace' | 'meta' | 'host', CodeBlockData>
}

const RUN = `$ cd my-app
$ brust dev
$ brust dev routes.tsx --port 3000 --workers 2`

// observed: `brust dev routes.tsx --port 4873` on the blank template with NO_COLOR=1 (so the plain, line-by-line output a pipe or CI gets), then a page edit, a stylesheet edit, a syntax error and its fix. Trimmed: the file-name noise an editor's temporary backup file added to one `change detected` line is left out.
const PLAIN = `[brust] dev server on http://127.0.0.1:4873 — [r]eload  [o]pen  [w]arnings  [c]lear  [q]uit
[brust] building http://127.0.0.1:4873 gen 0
[brust] change detected: .
[brust] ready http://127.0.0.1:4873 gen 1 (55ms)
GET / 200 2ms
[brust] change detected: pages/HomePage.tsx
[brust] building http://127.0.0.1:4873 gen 1 (55ms)
[brust] ready http://127.0.0.1:4873 gen 2 (46ms)
[brust] css public/app.css (no reload)
[brust] change detected: pages/HomePage.tsx
[brust] building http://127.0.0.1:4873 gen 2 (46ms)
[brust] build BuildMessage: Expected identifier but found end of file
[brust] error http://127.0.0.1:4873 gen 2 (46ms) — build BuildMessage: Expected identifier but found end of file
[brust] change detected: pages/HomePage.tsx
[brust] building http://127.0.0.1:4873 gen 2 (46ms)
[brust] ready http://127.0.0.1:4873 gen 4 (51ms)`

// observed: renderStatus() from packages/brust/src/dev/tui.ts called with a ready state and with a failing one (width 100).
const TTY = `● ready  http://127.0.0.1:1337  gen 3 · built in 46ms
  last: GET / → 200  ·  2 static 1 native 0 react
  [r]eload  [o]pen  [w]arnings  [c]lear  [q]uit`
const TTY_ERR = `✖ error  http://127.0.0.1:1337  gen 2 · built in 46ms
  error: build Expected identifier but found end of file
  warnings: 1 — hook-unsupported components/X.tsx:12:26 hook useReducer is not supported
  [r]eload  [o]pen  [w]arnings  [c]lear  [q]uit`

// observed: the \`#__brust_trace\` script of GET / on the blank template under \`brust dev\` (formatted here; the page carries it on one line).
const TRACE = `{
  "route": { "id": "r1", "pattern": "/", "chain": ["layout_9e14e5d1", "homePage_76d6b8d1"], "params": {} },
  "status": 200,
  "cache": "-",
  "loader_ms": null,
  "jobs": [],
  "jobs_more": 0,
  "truncated": false,
  "render_ms": 0.4255,
  "render_error": null,
  "bun_calls": 0,
  "rendered": ["layout_9e14e5d1", "homePage_76d6b8d1", "counter_4a7ef039"]
}`

// observed: GET /_brust/dev/meta on the same app (this is dev.json).
const META = `{
  "version": 1,
  "components": {
    "layout_9e14e5d1":   { "file": "components/Layout.tsx",  "tier": "static", "diagnostics": [] },
    "homePage_76d6b8d1": { "file": "pages/HomePage.tsx",     "tier": "static", "diagnostics": [] },
    "counter_4a7ef039":  { "file": "components/Counter.tsx", "tier": "native", "diagnostics": [] }
  }
}`

// observed: a request to the dev port with a Host header the dev server does not know answered 421.
const HOST = `$ curl -s -o /dev/null -w "%{http_code}\\n" -H 'Host: evil.example' localhost:4874/
421`

export async function devModeLoader(): Promise<DevModeData> {
  return {
    toc: [
      { id: 'run', title: 'Run it' },
      { id: 'loop', title: 'What happens when you save' },
      { id: 'try', title: 'Try it' },
      { id: 'reloads', title: 'What reloads and what does not' },
      { id: 'errors', title: 'Build errors' },
      { id: 'terminal', title: 'The terminal' },
      { id: 'devtools', title: 'The devtools overlay' },
      { id: 'trace', title: 'The dev trace' },
      { id: 'safety', title: 'What is dev only' },
    ],
    blocks: {
      run: codeBlock({ lang: 'sh', cwd: '~/my-app', code: RUN }),
      plain: codeBlock({ lang: 'text', cwd: 'brust dev, plain output', code: PLAIN }),
      tty: codeBlock({ lang: 'text', cwd: 'status block, a terminal', code: TTY }),
      ttyErr: codeBlock({ lang: 'text', cwd: 'status block, a failing build', code: TTY_ERR }),
      trace: codeBlock({ lang: 'json', file: '#__brust_trace', code: TRACE }),
      meta: codeBlock({ lang: 'json', file: '/_brust/dev/meta (dev.json)', code: META }),
      host: codeBlock({ lang: 'sh', cwd: '~', code: HOST }),
    },
  }
}

export default function DevMode({ blocks }: DevModeData) {
  return (
    <section style={{ display: 'contents' }}>
      <h1>Dev mode</h1>
      <Lead>
        <code>brust dev</code> rebuilds when you save, swaps the new build in without dropping the old one, and shows build errors above the last good page. A browser overlay explains what each page was made of. None of it exists under{' '}
        <code>brust start</code>.
      </Lead>

      <h2 id="run">Run it</h2>
      <CodeBlock code={blocks.run.code} lang={blocks.run.lang} cwd={blocks.run.cwd} html={blocks.run.html} />
      {/* source: packages/brust/src/cli.ts:12 (usage line: `brust dev [entry=routes.tsx] [--port N] [--workers N]`) and :104-111 (the Bun target is every target but cloudflare; `--` arguments are refused) */}
      <p>
        The entry is <code>routes.tsx</code> unless you name another file. <code>--port</code> sets the port you open in the browser (<code>0</code> picks a free one); <code>--workers</code> sets the Bun workers behind it.
      </p>
      {/* source: packages/brust/src/dev/bun.ts:19,105 (workers default 1) and :104 (the port and host come from the same config as `brust start`: brust.toml, environment, then the flag) */}
      <p>
        Dev mode uses one worker unless you ask for more, and reads the host and port from the same configuration as <code>brust start</code>, with <code>--port</code> on top.
      </p>
      {/* source: packages/brust/src/cli.ts:13 and :104-123 — `--target cloudflare` selects the wrangler loop instead; see the CLI page */}
      <Note>
        <code>brust dev --target cloudflare</code> is a different loop (it runs wrangler). It is described on the <a href="/docs/cli#dev">CLI page</a>.
      </Note>

      <h2 id="loop">What happens when you save</h2>
      {/* source: packages/brust/src/dev/proxy.ts:1-3 and :191-194 (the parent owns the port with Bun.serve and proxies to the active child) */}
      <p>
        The process you start is a small proxy. It owns your port and forwards every request to a <em>child</em>: a normal <code>brust start</code> running on a loopback port of its own.
      </p>
      <ol>
        <li>
          {/* source: packages/brust/src/dev/watch.ts:1-4 and :17-40 (debounced file events, one run at a time, changes during a run are kept for the next one); bun.ts:27 (DEBOUNCE_MS = 150) */}
          A file changes. After a 150 ms pause the watcher starts one build. A change that arrives while a build runs is kept and builds next: nothing is dropped, and two builds never overlap.
        </li>
        <li>
          {/* source: packages/brust/src/dev/bun.ts:166-178 (spawns `brust build <entry> --out-dir <dir> --dev` as a separate process with NODE_ENV=development) */}
          The build runs as its own process into a fresh folder under <code>.brust/dev/</code>, so nothing from the previous build is cached in memory.
        </li>
        <li>
          {/* source: packages/brust/src/dev/bun.ts:181-224 (boot: `brust start --dist-dir <dir>` on a free loopback port, ready when it prints `[brust] ready`, 60 s limit at :28 and :202-205) */}
          A new child starts on that build and the proxy waits for it to print <code>[brust] ready</code> (60 seconds at most).
        </li>
        <li>
          {/* source: packages/brust/src/dev/bun.ts:275-289 (swap: active = child, broadcast reload, then stop the old child) and :226-233 (SIGINT, then SIGKILL after 4 s, and its folder is removed) */}
          Only then does the proxy start sending requests to the new child, tell the open pages to reload, and stop the old child. Until that moment the old one kept serving.
        </li>
      </ol>
      {/* source: packages/brust/src/dev/bun.ts:1-4 (one SERVER per process, workers never restart, never an in-process reload) and :255-269 (a failed build or a failed boot calls fail() and leaves `active` as it was) */}
      <p>
        So a build that fails, or a new child that does not come up, never takes the site down: the old child stays active. The server is never reloaded in place; every build gets a fresh one.
      </p>
      {/* source: packages/brust/src/dev/bun.ts:244-248 and :112-113 (`counter` increments for every attempt, `gen` is set only on a successful swap); observed in the PLAIN log above: a failed build was gen 3, the next good one gen 4 */}
      <p>
        Every attempt takes a number, so a failed build uses one up: in the output below a syntax error was build 3 and its fix is <code>gen 4</code>.
      </p>
      <CodeBlock code={blocks.plain.code} lang={blocks.plain.lang} cwd={blocks.plain.cwd} html={blocks.plain.html} />
      {/* source: packages/brust/src/dev/proxy.ts:143-146 — before the first child is ready every request gets a small "building…" page (503) that reloads when the build is done */}
      <p>
        Before the first build is ready, the page you open is a short <q>building…</q> notice (status 503) that reloads on its own.
      </p>

      <h2 id="try">Try it</h2>
      <p>The same loop with the lines it prints. Nothing is built here: each button applies the rules above to the numbers on the left.</p>
      <Frame title="Live demo" label="DevLoopDemo · native" nvp>
          <DevLoopDemo />
        
      </Frame>

      <h2 id="reloads">What reloads and what does not</h2>
      {/* source: packages/brust/src/dev/client.ts:1-11 (the messages the page client handles: hello, reload, error, css, css-swap) and :64-78 (handle) */}
      <p>The proxy keeps a WebSocket open to every page and tells it what to do. There are three outcomes.</p>
      <table>
        <thead>
          <tr>
            <th>You change</th>
            <th>What the proxy does</th>
            <th>The page</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              {/* source: packages/brust/src/dev/bun.ts:291 (isCss: under public/ and ending in .css) and :298-307 (copied into the active dist, no build, no new child) */}
              <code>public/*.css</code>
            </td>
            <td>Copies the file into the running build and skips the build.</td>
            <td>Swaps the stylesheet link. No reload, no state lost.</td>
          </tr>
          <tr>
            <td>
              {/* source: packages/brust/src/dev/bun.ts:58-86 (cssSwapMap: built stylesheets paired old to new by source name; null unless one to one) and :282-286 and :309-311 (a rebuild whose only changes are built .css files swaps instead of reloading) */}
              A stylesheet you <code>import</code> (a global file or a CSS Module)
            </td>
            <td>Rebuilds and boots a new child as usual.</td>
            <td>Swaps each built stylesheet link when the old and new builds have the same stylesheets one to one. If one was added or removed, the page reloads.</td>
          </tr>
          <tr>
            <td>
              {/* source: packages/brust/src/dev/bun.ts:286 (broadcast reload) and client.ts:71 (location.reload()) */}
              Anything else: a page, a component, a loader, <code>brust.toml</code>
            </td>
            <td>Rebuilds, boots a new child, swaps it in.</td>
            <td>Reloads.</td>
          </tr>
        </tbody>
      </table>
      {/* source: packages/brust/src/dev/client.ts:64-70 (hello on every connect: a page older than the serving build reloads) and :80-90 (reconnect with a 150 ms delay that doubles up to 2 s) */}
      <p>
        A page that was open while the dev server was down reconnects on its own (retrying every 150 ms, backing off to 2 seconds) and reloads if it is behind the build that is now serving.
      </p>
      {/* source: packages/brust/src/dev/watch.ts:54-61 (defaultIgnored: node_modules, .git, .wrangler, .brust, editor temp files, databases) and bun.ts:295 (the out folder `dist` is ignored too) */}
      <p>
        The watcher ignores <code>node_modules</code>, <code>.git</code>, <code>.wrangler</code>, <code>.brust</code>, <code>dist</code>, editor swap and temporary files, and database files (<code>.sqlite</code>, <code>.db</code>).
      </p>

      <h2 id="errors">Build errors</h2>
      {/* source: packages/brust/src/dev/diag.ts:1-22 (parseBuildError reads `error <rule> <file:line:col> <message>` from the build output) and bun.ts:255-259 (a failed build becomes the error state; a failed boot uses the rule `boot`, :266-267) */}
      <p>
        When a build fails, the pages already open show the error as an overlay: the rule, the file and position when there is one, and the build's own text. The page under it is the last good build, still working.
      </p>
      {/* source: packages/brust/src/dev/client.ts:26-38 (showOverlay: a <brust-dev-overlay> element with a shadow root, text "The page below is the last good build…") and :64-68 (hello with state error shows it; any good state clears it) */}
      <p>
        The overlay is a shadow-root element, so the page's CSS cannot touch it and it cannot touch the page. It goes away by itself on the next successful build. A tab you open while the build is broken shows it at once.
      </p>
      {/* source: packages/brust/src/dev/proxy.ts:187 — a document request answered with a 5xx by your app is shown as a small HTML page with the status and the body, so the dev client is still on it */}
      <p>If your own code returns a server error for a page, the proxy shows it as a plain page with the status and the response body, and the reload channel stays connected.</p>

      <h2 id="terminal">The terminal</h2>
      {/* source: packages/brust/src/dev/tui.ts:1-3 (never the alternate screen; a status block of at most 6 lines at the bottom; plain lines when not a TTY, CI or NO_COLOR) and :60-65 (tuiMode) */}
      <p>
        In a terminal, <code>brust dev</code> prints request lines that scroll normally and keeps a short status block at the bottom (never more than six lines, and it never takes over the screen). When the output is not a terminal, or <code>CI</code>{' '}
        or <code>NO_COLOR</code> is set, you get plain lines only, as in the log above.
      </p>
      <CodeBlock code={blocks.tty.code} lang={blocks.tty.lang} cwd={blocks.tty.cwd} html={blocks.tty.html} />
      {/* source: packages/brust/src/dev/tui.ts:42-52 (renderStatus: state line, the last page's tier counts or the error, a warnings count, the hotkeys) and bun.ts:119,156 (tier counts come from the page's trace and dev.json) */}
      <p>
        The second line is the last page you loaded and how many of its components were static, native and React (taken from that page's trace). While the build is broken it shows the error instead, and a count of the warnings the build printed.
      </p>
      <CodeBlock code={blocks.ttyErr.code} lang={blocks.ttyErr.lang} cwd={blocks.ttyErr.cwd} html={blocks.ttyErr.html} />
      {/* source: packages/brust/src/dev/bun.ts:340-353 (raw-mode keys, only in an interactive terminal: q or Ctrl-C quit, r reload, o open, w warnings, c clear) and :355-356 (SIGINT and SIGTERM stop it) */}
      <table>
        <thead>
          <tr>
            <th>Key</th>
            <th>Does</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>r</code>
            </td>
            <td>Reloads every open page.</td>
          </tr>
          <tr>
            <td>
              <code>o</code>
            </td>
            <td>Opens the dev URL in your browser.</td>
          </tr>
          <tr>
            <td>
              <code>w</code>
            </td>
            <td>Prints the warnings of the last build (or says there are none).</td>
          </tr>
          <tr>
            <td>
              <code>c</code>
            </td>
            <td>Clears the screen and redraws the status block.</td>
          </tr>
          <tr>
            <td>
              <code>q</code> or <code>Ctrl-C</code>
            </td>
            <td>Stops the build, the child and the proxy, and removes <code>.brust/dev</code>.</td>
          </tr>
        </tbody>
      </table>

      <h2 id="devtools">The devtools overlay</h2>
      {/* source: packages/brust/src/dev/devtools.ts:1-5 (the browser overlay of `brust dev`; served by the dev proxy; nothing of it exists under `brust start` or in a production build; everything it shows comes from the trace, dev.json, the DOM or the dev global) and proxy.ts:51 and :203-208 (the proxy injects the script tag and serves the bundle) */}
      <p>
        Every HTML page served through the dev proxy carries <code>&lt;brust-devtools&gt;</code>, a small indicator in the bottom-right corner that reads like <code>ready · 2s 1n 0r</code>: the build state and how many components of this page are static, native and React.
        Click it, or press <code>Alt+Shift+B</code>, to open the panel; <code>Esc</code> closes it.
      </p>
      {/* source: docs/plans/m1a-followups.md row F113 ("Alt+Shift+B is swallowed while focus is inside an input/textarea/contenteditable (accepted)") and devtools.ts:102 (the indicator is a button whose click toggles the panel) */}
      <p>
        While focus is inside a text field, the shortcut does not open the panel (the field takes the key). Click the indicator instead.
      </p>
      {/* source: packages/brust/src/dev/devtools.ts:28 (TABS) and :178-190 (render) and the panel functions :199-297 */}
      <table>
        <thead>
          <tr>
            <th>Panel</th>
            <th>Shows</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Page</td>
            <td>
              {/* source: devtools.ts:199-214 (pagePanel) */}
              The route and its pattern, the params, status, cache result, loader and render time, the number of worker calls, and a render error if there was one.
            </td>
          </tr>
          <tr>
            <td>Components</td>
            <td>
              {/* source: devtools.ts:216-241 (componentsPanel: the layout chain as a tree, extras listed apart) and :243-251 (highlight via chain markers, [x-data] and brust-island) */}
              The layouts and page that rendered, each with its tier and source file. A React component also shows why the compiler chose React, and its warnings. Hover or focus a row to outline that component on the page.
            </td>
          </tr>
          <tr>
            <td>Jobs</td>
            <td>
              {/* source: devtools.ts:253-261 (jobsPanel) */}
              The jobs this render called, whether each was a cache hit, and its key and tags. A cache hit page says no jobs ran.
            </td>
          </tr>
          <tr>
            <td>Store</td>
            <td>
              {/* source: devtools.ts:263-274 (storePanel: seed from script[data-brust-store], live values read from Symbol.for('brust.stores'), actions never called) */}
              For each store on the page, the server-rendered seed and the live values of its signals.
            </td>
          </tr>
          <tr>
            <td>Islands</td>
            <td>
              {/* source: devtools.ts:276-282 (islandsPanel: every brust-island and its data-hydrated) */}
              Each React island and whether it has hydrated.
            </td>
          </tr>
          <tr>
            <td>Build</td>
            <td>
              {/* source: devtools.ts:284-296 (buildPanel) */}
              The build state and generation, the current error, and every warning of the build with its file, rule and remediation.
            </td>
          </tr>
          <tr>
            <td>Requests</td>
            <td>
              {/* source: devtools.ts:298-304 (requestsPanel) and proxy.ts:33 (MAX_TRACES = 50) */}
              The last 50 page and action requests the dev proxy saw, newest first, with status, time and cache result.
            </td>
          </tr>
        </tbody>
      </table>
      {/* source: packages/brust/src/dev/devtools.ts:163-168 (tablist keys: ArrowLeft/ArrowRight wrap, Home, End) and :104 (Esc) and :89-98 (button, dialog and tablist roles) */}
      <p>
        It works from the keyboard: the arrow keys, <code>Home</code> and <code>End</code> move between tabs, and focus returns to where it was when you close it. It lives in a shadow root, so it does not change your page's styles, and your styles do not change it.
      </p>

      <h2 id="trace">The dev trace</h2>
      {/* source: crates/brust-core/src/trace.rs:1-5 (collected only when the core was started with a dev token AND the request carries it; answered as `x-brust-dev: base64(json)`; never cached; one Option check in production) and :10-12 (header names) */}
      <p>
        The panels read a <em>trace</em> of each page: which route matched, which components rendered, which jobs ran. The Rust core records it only when the request carries a secret that <code>brust dev</code> made up at start-up and gave to its child,
        and answers it in an <code>x-brust-dev</code> header (base64 of JSON, 32 KiB at most; a bigger one is cut down and flagged <code>truncated</code>). A trace is never cached.
      </p>
      {/* source: packages/brust/src/dev/bun.ts:111 (crypto.randomUUID() per session) and proxy.ts:147-149 (the proxy overwrites x-brust-dev-token on every upstream request) and :167-169 (the header is read and removed, it never reaches the browser) */}
      <p>
        The proxy adds the secret to every request it forwards (replacing any value a browser sent), reads the trace header and removes it. The browser never sees the header: the proxy puts the trace into the page and keeps the last 50.
      </p>
      <CodeBlock code={blocks.trace.code} lang={blocks.trace.lang} file={blocks.trace.file} html={blocks.trace.html} />
      {/* source: packages/brust/src/dev/proxy.ts:69-70 (traceTag: <script type=application/json id=__brust_trace>, `<` escaped), :49 and :201 (/_brust/dev/traces), :50 and :202 (/_brust/dev/meta) */}
      <p>
        Three dev-only URLs on the dev port expose the same data: the <code>#__brust_trace</code> script in each traced page, <code>/_brust/dev/traces</code> (the last 50 requests), and <code>/_brust/dev/meta</code>.
      </p>
      {/* source: packages/brust/src/build/index.ts:99-103 and :269 (`brust build --dev` writes dev.json) and :310-327 (devJson: component id to file, tier, the react reason, diagnostics), build/index.ts:99 */}
      <p>
        <code>/_brust/dev/meta</code> is <code>dev.json</code>, written only by <code>brust build --dev</code> (which <code>brust dev</code> runs for you). It maps each component id in the trace to its source file, its tier, why the compiler chose React when it did, and the build's diagnostics for it.
      </p>
      <CodeBlock code={blocks.meta.code} lang={blocks.meta.lang} file={blocks.meta.file} html={blocks.meta.html} />

      <h2 id="safety">What is dev only</h2>
      {/* source: packages/brust/src/dev/proxy.ts:112-121 and :203-208 (the devtools bundle is built and served by the dev proxy only), crates/brust-core/src/trace.rs:4 (no token, no trace), packages/brust/src/build/index.ts:99 (dev.json and the dev client runtime only with --dev); tests/server/devtools.chromium.test.ts ("it is dev-only: brust start serves no <brust-devtools> and no devtools bundle") */}
      <p>
        <code>brust start</code> and <code>brust build</code> without <code>--dev</code> never include any of this: no overlay, no client script, no trace header, no <code>dev.json</code>. A production server has no dev token, so it records no trace.
      </p>
      {/* source: packages/brust/src/dev/proxy.ts:88-99 (allowedHosts: loopback names, the configured host, BRUST_DEV_ALLOWED_HOSTS) and :198 (421 for any other Host) and :101-110 and :199 (a WebSocket from another origin is refused) */}
      <p>
        The dev server answers only to its own names: loopback, the host you configured, and any names in <code>BRUST_DEV_ALLOWED_HOSTS</code> (comma separated, for a tunnel or a local alias). A request with another <code>Host</code> header gets a 421, so a web page on
        another site cannot reach your app or your source paths through the dev port by pointing its own name at 127.0.0.1. The reload WebSocket refuses a page from another origin.
      </p>
      <CodeBlock code={blocks.host.code} lang={blocks.host.lang} cwd={blocks.host.cwd} html={blocks.host.html} />
      <Note>
        Dev mode is for your machine. Do not expose the dev port to a network you do not trust: the build error overlay and the trace carry file paths and source positions.
      </Note>
    </section>
  )
}
