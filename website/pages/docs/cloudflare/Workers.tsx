// Workers target — port of docs/cloudflare.md (v2, reviewed): build, generated project, bindings, actions, differences,
// limits, troubleshooting. Every code block is built in the loader (lib/highlight.ts). Cloudflare figures were read on
// 2026-10-12 (sources C1-C6 at the bottom).
import CodeBlock from '../../../components/CodeBlock'
import Note from '../../../components/docs/Note'
import { type CodeBlockData, type CodeBlockInput, codeBlock } from '../../../lib/highlight'
import type { TocItem } from '../../../lib/nav'
import ElysiaLink from '../../../components/ElysiaLink'
import Lead from '../../../components/docs/Lead'
import TableWrap from '../../../components/docs/TableWrap'

const SRC = {
  create: {
    lang: 'sh',
    cwd: '~/',
    code: `$ bun create @brust/app@latest my-app   # pin or use @latest: \`bun create\` caches the scaffolder
$ cd my-app
$ bun install
$ bun run dev:cf      # build + wrangler dev (local workerd, simulated bindings)
$ bun run deploy:cf   # build + wrangler deploy of dist/cf`,
  },
  scripts: {
    lang: 'json',
    file: 'package.json',
    code: `"dev:cf": "brust dev routes.tsx --target cloudflare",
"deploy:cf": "brust build routes.tsx --target cloudflare && wrangler deploy -c dist/cf/wrangler.jsonc"`,
  },
  toml: {
    lang: 'toml',
    file: 'brust.toml',
    code: `[cloudflare]
name = "my-worker"                # wrangler \`name\`
compatibility_date = "2026-10-01" # must be >= 2026-08-04
l1_capacity = 256                 # page cache entries per isolate
job_cache_capacity = 512          # job cache entries per isolate
stats = false                     # serve /_brust/cache/stats
edge_cache = "off"                # the only accepted value today

[cloudflare.alias]
"lib/team-db.ts" = "lib/team-db.d1.ts"`,
  },
  layout: {
    lang: 'text',
    cwd: 'dist/cf',
    code: `dist/cf/
  wrangler.jsonc            merged config (wrangler.jsonc section below)
  worker/                   the @brust/core-cf glue + wasm, copied verbatim
    brust-app.js            ONE Bun bundle of your app
    main.js                 only with a Durable Object cache adapter: re-exports the Worker and BrustCacheDO
  assets/                   Workers Static Assets
    _brust/client/*         copies of dist/client
    public/*                copies of dist/public
    _headers                cache headers
  .stage/                   generated entry, templates, smoke check (kept for inspection)`,
  },
  merged: {
    lang: 'json',
    file: 'dist/cf/wrangler.jsonc',
    code: `{
  "main": "worker/index.js",
  "compatibility_date": "2026-10-01",
  "assets": { "directory": "assets", "binding": "ASSETS", "run_worker_first": false,
              "html_handling": "none", "not_found_handling": "none" }
}`,
  },
  env: {
    lang: 'ts',
    file: 'lib/team-db.ts',
    code: `import { env } from 'cloudflare:workers'

export function db() {
  const d1 = env.TEAM_DB
  if (!d1) throw new Error('TEAM_DB D1 binding missing: add it to wrangler.jsonc')
  return d1
}`,
  },
} satisfies Record<string, CodeBlockInput>

export interface WorkersData {
  toc: TocItem[]
  blocks: Record<keyof typeof SRC, CodeBlockData>
}

export async function workersLoader(): Promise<WorkersData> {
  return {
    toc: [
      { id: 'quick-start', title: 'Quick start' },
      { id: 'commands', title: 'Commands' },
      { id: 'config', title: '[cloudflare] in brust.toml' },
      { id: 'generated', title: 'What the build generates' },
      { id: 'bindings', title: 'Bindings' },
      { id: 'actions', title: 'Actions on Workers' },
      { id: 'differences', title: 'Differences from native' },
      { id: 'limits', title: 'Limits' },
      { id: 'troubleshooting', title: 'Troubleshooting' },
      { id: 'sources', title: 'Sources' },
    ],
    blocks: Object.fromEntries(Object.entries(SRC).map(([k, v]) => [k, codeBlock(v)])) as WorkersData['blocks'],
  }
}

export default function Workers({ blocks }: WorkersData) {
  return (
    <>
      <h1>Workers target</h1>
      <Lead>
        brust builds the same app for Cloudflare Workers that it runs natively with <code>brust start</code>. The page renderer is the same Rust code, compiled to WebAssembly.
      </Lead>
      <p>
        The only JavaScript that runs is the shim <code>worker-build</code> generates and your own compiled TypeScript: loaders, <code>jobs.js</code>, <code>actions.ts</code>, client chunks. brust adds no runtime layer of its own, and the runtime needs only Workers. It ships no Durable Object, KV namespace or D1 database.
      </p>
      <p>
        The target is <b>Workers with Static Assets</b>. Cloudflare Pages is not targeted: its landing page says &ldquo;Start new projects with Workers&rdquo; (source C1). Cross-instance cache invalidation has its own pages: <a href="/docs/cloudflare/cache">Cache on KV and DO</a> and <a href="/docs/cache-adapters/overview">Cache adapters</a>.
      </p>

      <h2 id="quick-start">Quick start</h2>
      <CodeBlock code={blocks.create.code} lang={blocks.create.lang} cwd={blocks.create.cwd} html={blocks.create.html} />
      <p>
        <code>bun run deploy:cf</code> needs a Cloudflare login on your machine (<code>wrangler login</code>) or an API token in the environment. The scripts are:
      </p>
      <CodeBlock code={blocks.scripts.code} lang={blocks.scripts.lang} file={blocks.scripts.file} html={blocks.scripts.html} />
      <p>
        You need Bun and <code>wrangler</code>. You do not need a Rust toolchain: the app-independent wasm ships as the npm package <code>@brust/core-cf</code>, which installs next to <code>@brust/core</code>.
      </p>

      <h2 id="commands">Commands</h2>
      <TableWrap label="Commands">
        <table>
          <thead>
            <tr>
              <th>Command</th>
              <th>What it does</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>brust build [entry] --target cloudflare [--out-dir dist] [--wasm-from-source]</code>
              </td>
              <td>
                The normal build into <code>dist/</code>, then the Workers project in <code>dist/cf/</code>.
              </td>
            </tr>
            <tr>
              <td>
                <code>brust dev [entry] --target cloudflare [--out-dir dist] [--port N] [--wasm-from-source] [-- &lt;wrangler args&gt;]</code>
              </td>
              <td>
                Builds, runs <code>wrangler dev</code> on <code>dist/cf/wrangler.jsonc</code>, and rebuilds and restarts it when a source file changes. There is no hot module replacement. Arguments after <code>--</code> go to wrangler.
              </td>
            </tr>
          </tbody>
        </table>
      </TableWrap>
      <p>
        <code>--target</code> takes <code>bun</code> (the default) or <code>cloudflare</code>. <code>brust dev</code> supports only <code>--target cloudflare</code> for now.
      </p>
      <p>
        <code>--wasm-from-source</code> builds the wasm from a brust checkout instead of using <code>@brust/core-cf</code>. It needs the checkout&rsquo;s pinned nightly Rust, the <code>wasm32-unknown-unknown</code> target and <code>worker-build</code>. App authors never need it.
      </p>

      <h2 id="config">[cloudflare] in brust.toml</h2>
      <p>
        The table is optional. Its presence is not required to use <code>--target cloudflare</code>; the defaults below apply. Unknown keys are a build error. <code>[server]</code> and <code>[workers]</code> are ignored on this target, with a warning.
      </p>
      <CodeBlock code={blocks.toml.code} lang={blocks.toml.lang} file={blocks.toml.file} html={blocks.toml.html} />
      <TableWrap label="cloudflare keys">
        <table>
          <thead>
            <tr>
              <th>Key</th>
              <th>Default</th>
              <th>Meaning</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>name</code>
              </td>
              <td>the app-root wrangler <code>name</code>, else <code>package.json</code> <code>name</code> made into a Worker name</td>
              <td>The Worker name. If both this and the wrangler file name the Worker and they differ, this wins, with a warning.</td>
            </tr>
            <tr>
              <td>
                <code>compatibility_date</code>
              </td>
              <td>the date <code>@brust/core-cf</code> was built with</td>
              <td>
                Must be <code>YYYY-MM-DD</code> and at least <code>2026-08-04</code>. From that date <code>nodejs_compat</code> is on by default, and brust needs it for <code>AsyncLocalStorage</code> (source C2).
              </td>
            </tr>
            <tr>
              <td>
                <code>l1_capacity</code>
              </td>
              <td>256</td>
              <td>Rendered pages kept per isolate (native default is 1000). Integer in 1..4294967295.</td>
            </tr>
            <tr>
              <td>
                <code>job_cache_capacity</code>
              </td>
              <td>512</td>
              <td>Job results kept per isolate. Same range.</td>
            </tr>
            <tr>
              <td>
                <code>stats</code>
              </td>
              <td>
                <code>false</code>
              </td>
              <td>
                Serve <code>/_brust/cache/stats</code>. When off, that path answers 404. The numbers are per isolate.
              </td>
            </tr>
            <tr>
              <td>
                <code>edge_cache</code>
              </td>
              <td>
                <code>&quot;off&quot;</code>
              </td>
              <td>
                Reserved. <code>&quot;workers-cache&quot;</code> is refused: the build says it lands later.
              </td>
            </tr>
            <tr>
              <td>
                <code>alias</code>
              </td>
              <td>none</td>
              <td>Module swaps, see below.</td>
            </tr>
          </tbody>
        </table>
      </TableWrap>
      <p>
        <code>[actions]</code>, <code>[cors]</code> and <code>[cache]</code> are read as on native. <code>[build] server_only</code> is honoured too.
      </p>

      <h3 id="alias">[cloudflare.alias]</h3>
      <p>
        Some modules do not exist on Workers: <code>bun:sqlite</code>, <code>Bun.file</code>, anything under <code>bun</code> or <code>bun:*</code>. An alias replaces a module of your app, at bundle time, with another one. Both sides are paths relative to the app root, and both must resolve. Use it to swap a database facade: the pokedex example maps <code>lib/team-db.ts</code> to <code>lib/team-db.d1.ts</code> (see the <a href="/docs/cloudflare/d1">D1 recipe</a>).
      </p>

      <h2 id="generated">What the build generates</h2>
      <CodeBlock code={blocks.layout.code} lang={blocks.layout.lang} cwd={blocks.layout.cwd} html={blocks.layout.html} />
      <p>
        <code>brust-app.js</code> is built from a short generated entry (about 25 lines, no logic). It imports your routes, <code>jobs.js</code> and <code>actions.ts</code> and exports <code>loader</code>, <code>jobs</code>, <code>action</code>, <code>install</code>, the manifest, the templates and a baked <code>CONFIG</code>. The wasm calls those exports directly. The bundle uses the <code>workerd</code>, <code>worker</code> and <code>browser</code> export conditions, so <code>react-dom/server</code> resolves to its edge build.
      </p>
      <p>
        After bundling, the build imports <code>brust-app.js</code> under Bun with a stub for <code>cloudflare:workers</code> and checks the exports. This catches a broken bundle before wrangler does. The check runs your modules&rsquo; top level with <code>env = {'{}'}</code>, so <b>open bindings lazily</b>, inside a call, not at import time.
      </p>

      <h3 id="wrangler">wrangler.jsonc</h3>
      <p>
        If your app root has a <code>wrangler.jsonc</code>, <code>wrangler.json</code> or <code>wrangler.toml</code>, brust merges it into the generated file. Keep only one of them. brust owns these keys and ignores yours with a warning: <code>main</code>, <code>assets</code>, <code>compatibility_date</code>, <code>no_bundle</code>, <code>find_additional_modules</code>, <code>base_dir</code>, <code>rules</code>, <code>build</code>, <code>site</code>. Everything else is yours: <code>name</code>, <code>vars</code>, <code>d1_databases</code>, <code>kv_namespaces</code>, <code>durable_objects</code>, <code>routes</code>, <code>observability</code> and so on, also under <code>env.&lt;name&gt;</code>.
      </p>
      <p>brust writes:</p>
      <CodeBlock code={blocks.merged.code} lang={blocks.merged.lang} file={blocks.merged.file} html={blocks.merged.html} />
      <p>Refused with an error:</p>
      <ul>
        <li>
          a binding named <code>ASSETS</code> (it is brust&rsquo;s static assets binding);
        </li>
        <li>
          a <code>compatibility_flags</code> entry starting with <code>no_nodejs_compat</code>.
        </li>
      </ul>
      <p>
        brust never writes an account identifier. It keeps one only if you wrote it. <code>migrations_dir</code> of each <code>d1_databases</code> entry, and relative <code>tsconfig</code> and <code>alias</code> paths, are rewritten relative to <code>dist/cf/</code>, so <code>wrangler d1 migrations apply</code> finds your files when run with <code>-c dist/cf/wrangler.jsonc</code>.
      </p>

      <h3 id="assets">Static assets and _headers</h3>
      <p>
        Files under <code>dist/client</code> and <code>dist/public</code> become assets at the URL they are requested at. Only files the native server would serve are copied; others are skipped with a warning. A request for an asset does not run the Worker. A miss under <code>/_brust/</code> or <code>/public/</code> reaches brust, which answers 404.
      </p>
      <p>
        <code>_headers</code> sets <code>X-Content-Type-Options: nosniff</code> and <code>X-Powered-By</code> on everything, <code>immutable</code> on <code>/_brust/client/*</code>, and per file on <code>/public/*</code>: <code>immutable</code> for names with a content hash, <code>max-age=3600</code> otherwise. A <code>_headers</code> file holds at most 100 rules; past that brust writes a single <code>/public/*</code> rule with <code>max-age=3600</code> and warns.
      </p>
      <p>
        Pages rendered by the Worker also carry <code>{'<meta name="generator" content="brust/<version>">'}</code> in their <code>&lt;head&gt;</code>, the same value as <code>X-Powered-By</code>.
      </p>

      <h2 id="bindings">Bindings and cloudflare:workers</h2>
      <p>
        Declare bindings in your own <code>wrangler.jsonc</code> and read them from the <code>env</code> export:
      </p>
      <CodeBlock code={blocks.env.code} lang={blocks.env.lang} file={blocks.env.file} html={blocks.env.html} />
      <p>Rules that follow from Workers (source C3):</p>
      <ul>
        <li>
          I/O (D1, KV, <code>fetch</code>) works only inside a request. Open bindings inside the function that uses them. Never keep an I/O object across requests.
        </li>
        <li>
          The build runs your module top level once, with an empty <code>env</code>. A top-level <code>env.DB.prepare(...)</code> fails the build smoke check.
        </li>
      </ul>

      <h2 id="actions">Actions on Workers</h2>
      <p>
        <a href="/docs/actions">Actions</a> run as on native: one <ElysiaLink label="Elysia 2" /> app, <code>[actions]</code> read from <code>brust.toml</code>. What differs:
      </p>
      <ul>
        <li>
          brust generates a startup <code>.compile()</code> of your Elysia app. Workers allow <code>eval()</code> and <code>new Function(text)</code> during the startup phase of a Worker script (source C4), and Elysia&rsquo;s compiler needs them, so compiling at startup is the safe place. Do not rely on lazy compilation in your own code.
        </li>
        <li>
          The admission rules still run in Rust: method gate, ambiguous path (400), <code>Content-Encoding</code> (415), body cap (413) and the cross-site guard (403). <code>cross_site = &quot;reject&quot;</code> is the default and works the same way.
        </li>
        <li>
          <code>cache.invalidate(...)</code> from an action clears the cache of the isolate that ran it. <a href="/docs/cloudflare/cache">Cache on KV and DO</a> explains how to reach the others.
        </li>
      </ul>

      <h2 id="differences">Differences from native</h2>
      <TableWrap label="Native versus Workers">
        <table>
          <thead>
            <tr>
              <th />
              <th>
                Native (<code>brust start</code>)
              </th>
              <th>Workers</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Page cache scope</td>
              <td>one process, all workers</td>
              <td>one isolate; capacity 256 pages by default</td>
            </tr>
            <tr>
              <td>
                <code>cache.invalidate</code>
              </td>
              <td>the whole process</td>
              <td>
                the running isolate; others after <code>ttl_seconds</code>, unless a cache adapter broadcasts
              </td>
            </tr>
            <tr>
              <td>Response compression</td>
              <td>gzip in Rust</td>
              <td>none in the Worker; Cloudflare compresses at the edge</td>
            </tr>
            <tr>
              <td>
                <code>/_brust/cache/stats</code>
              </td>
              <td>always on</td>
              <td>
                off (404) unless <code>stats = true</code>; per isolate
              </td>
            </tr>
            <tr>
              <td>Static files</td>
              <td>served by Rust</td>
              <td>
                Workers Static Assets, with the headers from <code>_headers</code>; the Worker is not run for a hit
              </td>
            </tr>
            <tr>
              <td>CORS on static assets</td>
              <td>stamped by the server</td>
              <td>
                <b>not stamped</b>: Static Assets answer without running brust. Only pages and actions get CORS headers
              </td>
            </tr>
            <tr>
              <td>Plan offer (loader and jobs in one call)</td>
              <td>on</td>
              <td>off: the loader and jobs are two direct in-isolate calls, which cost microseconds</td>
            </tr>
            <tr>
              <td>
                <code>[server]</code>, <code>[workers]</code>
              </td>
              <td>used</td>
              <td>ignored, with a warning</td>
            </tr>
            <tr>
              <td>
                Server-only modules (<code>bun:*</code>)
              </td>
              <td>allowed</td>
              <td>
                build error <code>cf-unsupported</code>; swap with <code>[cloudflare.alias]</code>
              </td>
            </tr>
            <tr>
              <td>
                Static site generation (<code>--ssg</code>)
              </td>
              <td>not in v2</td>
              <td>not targeted</td>
            </tr>
          </tbody>
        </table>
      </TableWrap>

      <h2 id="limits">Limits</h2>
      <p>Numbers below are Cloudflare&rsquo;s, read on 2026-10-12. They change; check the source before you size anything.</p>
      <TableWrap label="Cloudflare limits">
        <table>
          <thead>
            <tr>
              <th>Limit</th>
              <th>Free</th>
              <th>Paid</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Worker size (uncompressed)</td>
              <td>64 MiB</td>
              <td>64 MiB</td>
              <td>C5</td>
            </tr>
            <tr>
              <td>Startup (global scope)</td>
              <td>1 s</td>
              <td>1 s</td>
              <td>C5</td>
            </tr>
            <tr>
              <td>CPU time per HTTP request</td>
              <td>10 ms</td>
              <td>30 s default, up to 5 min</td>
              <td>C5</td>
            </tr>
            <tr>
              <td>Memory per isolate (JS heap and wasm)</td>
              <td>128 MB</td>
              <td>128 MB</td>
              <td>C5</td>
            </tr>
            <tr>
              <td>Subrequests per invocation</td>
              <td>50</td>
              <td>10,000</td>
              <td>C5</td>
            </tr>
            <tr>
              <td>Static Asset files per Worker version</td>
              <td>20,000</td>
              <td>100,000</td>
              <td>C5</td>
            </tr>
            <tr>
              <td>One Static Asset file</td>
              <td>25 MiB</td>
              <td>25 MiB</td>
              <td>C5</td>
            </tr>
            <tr>
              <td>D1 queries per invocation</td>
              <td>50</td>
              <td>1,000</td>
              <td>C6</td>
            </tr>
          </tbody>
        </table>
      </TableWrap>
      <p>What this means for brust:</p>
      <ul>
        <li>
          <b>Size.</b> The brust wasm plus glue is about 2.65 MB raw (0.79 MB gzip) in the minimal test app, measured by the brust CI on 2026-10-12. A real app adds <code>react-dom</code>, Elysia and its own code.
        </li>
        <li>
          <b>CPU.</b> A cache hit costs microseconds. A miss runs the loader, the jobs and the template render. The Free plan&rsquo;s 10 ms is tight for heavy pages; measure <code>wrangler dev</code> output on your own routes.
        </li>
        <li>
          <b>Memory.</b> Both caches live in the 128 MB. Lower <code>l1_capacity</code> if your pages are large. A body over 8 MiB is never cached.
        </li>
        <li>
          <b>Subrequests.</b> brust makes none of its own. Your D1, KV and <code>fetch</code> calls count.
        </li>
        <li>
          <b>Startup.</b> brust parses the manifest, compiles templates and compiles Elysia at startup. A large app should stay far from 1 s; wrangler&rsquo;s deploy output reports <code>startup_time_ms</code>.
        </li>
      </ul>

      <h2 id="troubleshooting">Troubleshooting</h2>
      <h3>
        <code>cf-unsupported</code>: file imports bun:sqlite
      </h3>
      <p>
        The module does not exist on Workers (also <code>bun</code>, <code>bun:*</code>). Replace it with a Workers-safe module and map it with <code>[cloudflare.alias]</code> (<a href="/docs/cloudflare/d1">D1 recipe</a>). A <code>server_only</code> entry keeps it out of browser bundles.
      </p>
      <h3>
        <code>cf-smoke</code> failure at build
      </h3>
      <p>The build imported your bundle with an empty env and an export was missing, or your top level threw. Move binding access into functions.</p>
      <h3>
        <code>cf-config</code>: more than one wrangler config
      </h3>
      <p>
        Keep one of <code>wrangler.jsonc</code>, <code>wrangler.json</code>, <code>wrangler.toml</code>.
      </p>
      <h3>
        <code>cf-config</code>: a binding named ASSETS
      </h3>
      <p>
        Rename yours. <code>ASSETS</code> belongs to brust&rsquo;s static assets.
      </p>
      <h3>compatibility_date must be &gt;= 2026-08-04</h3>
      <p>
        Raise <code>[cloudflare] compatibility_date</code>. brust needs <code>nodejs_compat</code> for <code>AsyncLocalStorage</code>.
      </p>
      <h3>@brust/core-cf is not installed</h3>
      <p>
        Run <code>bun add -d @brust/core-cf@&lt;same version as @brust/core&gt;</code>, or use <code>--wasm-from-source</code> in a brust checkout. A version mismatch with <code>@brust/core</code> prints a warning.
      </p>
      <h3>A binding is undefined</h3>
      <p>
        It is missing from your <code>wrangler.jsonc</code>, or it was read at import time. Check with <code>wrangler dev</code> and read bindings inside the request.
      </p>
      <h3>Error 10021 on deploy (startup too long)</h3>
      <p>The global scope took more than 1 s. Remove heavy work at module top level.</p>
      <h3>A page stays stale after a mutation</h3>
      <p>
        Expected without a cache adapter: other isolates serve the old page up to <code>ttl_seconds</code>. See <a href="/docs/cloudflare/cache">Cache on KV and DO</a>.
      </p>
      <Note>
        This page follows <code>docs/cloudflare.md</code> in the brust repository, the reviewed source. If the two ever disagree, the markdown wins.
      </Note>

      <h2 id="sources">Sources</h2>
      <p>All fetched 2026-10-12. Every figure and quotation above was re-read from these pages on that date.</p>
      <TableWrap label="Sources">
        <table>
          <thead>
            <tr>
              <th>Id</th>
              <th>Page</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>C1</td>
              <td>
                <a href="https://developers.cloudflare.com/pages/">developers.cloudflare.com/pages/</a>
              </td>
            </tr>
            <tr>
              <td>C2</td>
              <td>
                <a href="https://developers.cloudflare.com/workers/runtime-apis/nodejs/">developers.cloudflare.com/workers/runtime-apis/nodejs/</a>
              </td>
            </tr>
            <tr>
              <td>C3</td>
              <td>
                <a href="https://developers.cloudflare.com/workers/runtime-apis/bindings/#importing-env-as-a-global">developers.cloudflare.com/workers/runtime-apis/bindings/#importing-env-as-a-global</a>
              </td>
            </tr>
            <tr>
              <td>C4</td>
              <td>
                <a href="https://developers.cloudflare.com/workers/configuration/compatibility-flags/#enable-eval-during-startup">developers.cloudflare.com/workers/configuration/compatibility-flags/#enable-eval-during-startup</a>
              </td>
            </tr>
            <tr>
              <td>C5</td>
              <td>
                <a href="https://developers.cloudflare.com/workers/platform/limits/">developers.cloudflare.com/workers/platform/limits/</a>
              </td>
            </tr>
            <tr>
              <td>C6</td>
              <td>
                <a href="https://developers.cloudflare.com/d1/platform/limits/">developers.cloudflare.com/d1/platform/limits/</a>
              </td>
            </tr>
          </tbody>
        </table>
      </TableWrap>
    </>
  )
}
