// Quickstart — the reference docs page (canon port): four steps from an empty folder to a page served by Rust.
// Every code block is built in the loader (lib/highlight.ts); the CLI output is copied from a real run.
// The root is a fragment: a static component's fragment root emits no wrapper (F106), so every block is a grid item
// of the docs article and the article's rhythm applies.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import CodeBlock from '../../components/CodeBlock'
import Note from '../../components/docs/Note'
import Step from '../../components/docs/Step'
import { type CodeBlockData, codeBlock } from '../../lib/highlight'
import type { TocItem } from '../../lib/nav'

// Loader data merges with the layouts' (a page's keys win), so the blocks live under `blocks`: a top-level `version`
// or `title` would replace the header's version or the page title.
export interface QuickstartData {
  toc: TocItem[]
  blocks: Record<'version' | 'create' | 'page' | 'routes' | 'dev' | 'curl', CodeBlockData>
}

// The template files are read at build time from packages/create-app/templates/blank (gaps round L25): the page shows
// exactly what `bun create @brust/app` writes.
const TEMPLATE = join(import.meta.dir, '../../../packages/create-app/templates/blank')
const templateFile = (rel: string): string => readFileSync(join(TEMPLATE, rel), 'utf8').trimEnd()

// Real output of `bun run dev` (`brust dev routes.tsx`) in a freshly scaffolded blank app, as captured; the build time is machine-dependent.
const DEV_OUTPUT = `$ brust dev routes.tsx
[brust] dev server on http://127.0.0.1:1337 — [r]eload  [o]pen  [w]arnings  [c]lear  [q]uit
[brust] building http://127.0.0.1:1337 gen 0
[brust] change detected: .
[brust] ready http://127.0.0.1:1337 gen 1 (656ms)`

// Real response headers, the body cut.
const CURL_OUTPUT = `$ curl -i http://127.0.0.1:1337/
HTTP/1.1 200 OK
content-type: text/html; charset=utf-8
x-powered-by: brust/2.0.0-alpha.3
content-length: 1965`

export async function quickstartLoader(): Promise<QuickstartData> {
  return {
    toc: [
      { id: 'requirements', title: 'Check the requirements' },
      { id: 'create', title: 'Create the project' },
      { id: 'write', title: 'Write a page' },
      { id: 'run', title: 'Run it' },
      { id: 'next', title: 'Where to go next' },
    ],
    blocks: {
      version: codeBlock({ lang: 'sh', cwd: '~/', code: '$ bun --version\n1.4.3' }),
      create: codeBlock({ lang: 'sh', cwd: '~/', code: '$ bun create @brust/app@latest my-app\n$ cd my-app && bun install' }),
      page: codeBlock({ lang: 'tsx', file: 'pages/HomePage.tsx', code: templateFile('pages/HomePage.tsx') }),
      routes: codeBlock({ lang: 'ts', file: 'routes.tsx', code: templateFile('routes.tsx') }),
      dev: codeBlock({ lang: 'sh', cwd: '~/my-app', code: DEV_OUTPUT }),
      curl: codeBlock({ lang: 'sh', cwd: '~/my-app', code: CURL_OUTPUT }),
    },
  }
}

export default function Quickstart({ blocks }: QuickstartData) {
  return (
    <>
      <h1>Quickstart</h1>
      <p className="lead">From an empty folder to a page served by Rust. Four steps, each one a command or a file you can copy as is.</p>

      <Step n={1} id="requirements" title="Check the requirements" />
      <p>Bun 1.4 or newer. The Rust server ships prebuilt for macOS and Linux, so there is no Rust toolchain to install.</p>
      <CodeBlock code={blocks.version.code} lang={blocks.version.lang} cwd={blocks.version.cwd} html={blocks.version.html} />

      <Step n={2} id="create" title="Create the project" />
      <p>The blank template has one layout, one page (the brust mark, a native counter and three links to these docs), the site favicon, and the scripts you will use every day.</p>
      <CodeBlock code={blocks.create.code} lang={blocks.create.lang} cwd={blocks.create.cwd} html={blocks.create.html} />
      <Note>
        Keep the <code>@latest</code>. <code>bun create</code> caches the scaffolder, and a stale cache gives you an old template.
      </Note>

      <Step n={3} id="write" title="Write a page" />
      <p>
        A page is a plain React component. <code>routes.tsx</code> maps paths to components, and the layout wraps every page through <code>Outlet</code>.
      </p>
      <CodeBlock code={blocks.page.code} lang={blocks.page.lang} file={blocks.page.file} html={blocks.page.html} />
      <CodeBlock code={blocks.routes.code} lang={blocks.routes.lang} file={blocks.routes.file} html={blocks.routes.html} />
      <p>
        This page has no state and no handlers, so the compiler marks it <span className="tier static">static</span>: rendered once, served as HTML, no client JavaScript.
      </p>

      <Step n={4} id="run" title="Run it" />
      <p>
        <code>bun run dev</code> starts the dev server, which builds the app and rebuilds it when a file changes. Open the address it prints.
      </p>
      <CodeBlock code={blocks.dev.code} lang={blocks.dev.lang} cwd={blocks.dev.cwd} html={blocks.dev.html} />
      <CodeBlock code={blocks.curl.code} lang={blocks.curl.lang} cwd={blocks.curl.cwd} html={blocks.curl.html} />

      <Step n={5} id="next" title="Where to go next" />
      <ul>
        <li>
          <a href="/docs/routing">Routing</a>: nested layouts, path params, the catch-all 404.
        </li>
        <li>
          <a href="/docs/loaders">Loaders and params</a>: fetch data per route in Bun.
        </li>
        <li>
          <a href="/docs/rendering-tiers">Rendering tiers</a>: what makes a component static, native, or a React island.
        </li>
      </ul>
    </>
  )
}
