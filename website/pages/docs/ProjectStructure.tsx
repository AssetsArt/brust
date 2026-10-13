// Project structure — the blank template's files, the scripts, and what `brust build` writes to dist/.
import CodeBlock from '../../components/CodeBlock'
import FileTree from '../../components/demos/FileTree'
import { type CodeBlockData, codeBlock } from '../../lib/highlight'
import type { TocItem } from '../../lib/nav'

export interface ProjectStructureData {
  toc: TocItem[]
  blocks: Record<'tree' | 'scripts' | 'dist', CodeBlockData>
  files: { path: string; role: string }[]
}

const TREE = `my-app/
├── routes.tsx
├── components/
│   ├── Layout.tsx
│   └── Counter.tsx
├── pages/
│   └── HomePage.tsx
├── actions.ts
├── public/
│   ├── app.css
│   └── favicon.svg
├── brust.toml
├── wrangler.jsonc
├── package.json
└── tsconfig.json`

const SCRIPTS = `{
  "scripts": {
    "dev": "brust build routes.tsx && brust start",
    "build": "brust build routes.tsx",
    "start": "brust start",
    "typecheck": "bun check",
    "dev:cf": "brust dev routes.tsx --target cloudflare",
    "deploy:cf": "brust build routes.tsx --target cloudflare && wrangler deploy -c dist/cf/wrangler.jsonc"
  }
}`

const DIST = `dist/
├── manifest.json      every route and component, with its tier
├── jinja/<id>.jinja   the compiled template of each component
├── client/*.js        native chunks and React islands, content-hashed
├── jobs.js            the server code: loaders and jobs
├── actions.js         your actions app, when [actions] is on
├── public/            a copy of ./public
└── index.js           bun dist/index.js starts the server`

export async function projectStructureLoader(): Promise<ProjectStructureData> {
  return {
    toc: [
      { id: 'files', title: 'The files' },
      { id: 'scripts', title: 'The scripts' },
      { id: 'dist', title: 'What brust build writes' },
    ],
    blocks: {
      tree: codeBlock({ lang: 'text', cwd: '~/my-app', code: TREE }),
      scripts: codeBlock({ lang: 'json', file: 'package.json', code: SCRIPTS }),
      dist: codeBlock({ lang: 'text', cwd: '~/my-app', code: DIST }),
    },
    files: [
      { path: 'routes.tsx', role: 'Maps paths to components with defineRoutes. The entry brust build reads.' },
      { path: 'components/Layout.tsx', role: 'The document root: <html>, <head>, and <Outlet/> where each page renders.' },
      { path: 'pages/HomePage.tsx', role: 'The page at /. A heading and the counter.' },
      { path: 'components/Counter.tsx', role: 'A useState counter. The compiler makes it native: a signal in the browser, no React shipped.' },
      { path: 'actions.ts', role: 'An Elysia 2 app built with the brust() adapter, one GET /hello route. Never call app.listen(): Rust owns HTTP.' },
      { path: 'public/', role: 'Static files, served as they are at /public/... (the layout links /public/app.css and /public/favicon.svg).' },
      { path: 'brust.toml', role: 'Server address and port, and an empty [actions] table that turns actions on with their defaults.' },
      { path: 'wrangler.jsonc', role: 'Cloudflare bindings for the Workers target. brust owns the build keys (main, assets, compatibility_date, ...).' },
      { path: 'package.json', role: 'The scripts below, @brust/core, React 19 and the pinned Elysia packages.' },
    ],
  }
}

export default function ProjectStructure({ blocks, files }: ProjectStructureData) {
  return (
    <>
      <h1>Project structure</h1>
      <p className="lead">A brust app is a routes file, components, an optional actions app, and a brust.toml. This is the blank template.</p>

      <h2 id="files">The files</h2>
      <CodeBlock code={blocks.tree.code} lang={blocks.tree.lang} cwd={blocks.tree.cwd} html={blocks.tree.html} />
      <p>Pick a file to see what it does.</p>
      <div className="browser">
        <div className="url">
          <span>Live demo</span>
          <span className="lbl">FileTree · native</span>
        </div>
        <div className="vp">
          <FileTree files={files} />
        </div>
      </div>
      <p>
        Only <code>routes.tsx</code> is required by name, and you can pass another entry to <code>brust build</code>. The <code>components/</code> and <code>pages/</code> split is a convention: the compiler follows imports, not folders.
      </p>

      <h2 id="scripts">The scripts</h2>
      <CodeBlock code={blocks.scripts.code} lang={blocks.scripts.lang} file={blocks.scripts.file} html={blocks.scripts.html} />
      <p>
        <code>dev</code> builds once and starts the server; it does not watch files. Run it again after a change. The <code>:cf</code> scripts target Cloudflare Workers, see <a href="/docs/deployment">Deployment</a>.
      </p>

      <h2 id="dist">What brust build writes</h2>
      <CodeBlock code={blocks.dist.code} lang={blocks.dist.lang} cwd={blocks.dist.cwd} html={blocks.dist.html} />
      <p>
        The build writes to a temporary folder next to <code>dist/</code> and swaps it in only when it succeeds, so a failed build leaves the last good one in place. <code>dist/</code> imports <code>react</code> and <code>@brust/core</code> at runtime: keep it inside the app, next to its <code>node_modules</code>.
      </p>
    </>
  )
}
