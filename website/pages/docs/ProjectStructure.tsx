// Project structure — the blank template's files, the scripts, and what `brust build` writes to dist/.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import CodeBlock from '../../components/CodeBlock'
import FileTree from '../../components/demos/FileTree'
import { type CodeBlockData, codeBlock } from '../../lib/highlight'
import type { TocItem } from '../../lib/nav'
import Frame from '../../components/docs/Frame'
import Lead from '../../components/docs/Lead'

export interface ProjectStructureData {
  toc: TocItem[]
  blocks: Record<'tree' | 'scripts' | 'dist', CodeBlockData>
  files: { path: string; role: string }[]
}

// source: packages/create-app/templates/blank (L28 part A, PR #180): app.css at the root (Tailwind CSS v4), imported
// by components/Layout.tsx:4; public/ holds only favicon.svg; _gitignore is written as .gitignore, *.tmpl without .tmpl.
// website/test/project-structure.test.ts checks this tree against the template folder.
const TREE = `my-app/
├── routes.tsx
├── app.css
├── components/
│   ├── Layout.tsx
│   └── Counter.tsx
├── pages/
│   └── HomePage.tsx
├── actions.ts
├── public/
│   └── favicon.svg
├── brust.toml
├── wrangler.jsonc
├── package.json
├── tsconfig.json
├── README.md
└── .gitignore`

// The scripts and dev dependencies are read at build time from the template's package.json, so the block is what
// `bun create @brust/app` writes. source: packages/create-app/templates/blank/package.json.tmpl:7 (dev = brust dev)
// and :21 (devDependencies: tailwindcss, @tailwindcss/node and @tailwindcss/oxide, pinned at one version).
const TEMPLATE_PKG = join(import.meta.dir, '../../../packages/create-app/templates/blank/package.json.tmpl')
const templatePkg = JSON.parse(readFileSync(TEMPLATE_PKG, 'utf8').replace('__BRUST_DEP__', '""')) as {
  scripts: Record<string, string>
  devDependencies: Record<string, string>
}
const SCRIPTS = JSON.stringify({ scripts: templatePkg.scripts, devDependencies: templatePkg.devDependencies }, null, 2)

// source: packages/brust/src/build/css.ts:1-2 and :194-197 (one minified client/<stem>-<hex10>.css per source
// stylesheet) and :5-6 (a route links the CSS its layout and page import, in <head>); docs/css.md:70 (no JS bundle has CSS).
const DIST = `dist/
├── manifest.json      every route and component, with its tier
├── jinja/<id>.jinja   the compiled template of each component
├── client/*.js        native chunks and React islands, content-hashed
├── client/*.css       app.css and the Tailwind utilities you use, minified, hashed
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
      { path: 'app.css', role: 'Tailwind CSS v4: @import "tailwindcss" and a @theme of color tokens (bg-paper, text-ink, ...). The layout imports it; brust builds it and links it in <head>.' },
      { path: 'components/Layout.tsx', role: "The document root: <html>, <head>, and <Outlet/> where each page renders. It imports ../app.css." },
      { path: 'pages/HomePage.tsx', role: 'The page at /. A heading and the counter.' },
      { path: 'components/Counter.tsx', role: 'A useState counter. The compiler makes it native: a signal in the browser, no React shipped.' },
      { path: 'actions.ts', role: 'An Elysia 2 app built with the brust() adapter, one GET /hello route. Never call app.listen(): Rust owns HTTP.' },
      { path: 'public/', role: 'Static files, served as they are at /public/... (the layout links /public/favicon.svg).' },
      { path: 'brust.toml', role: 'Server address and port, and an empty [actions] table that turns actions on with their defaults.' },
      { path: 'wrangler.jsonc', role: 'Cloudflare bindings for the Workers target. brust owns the build keys (main, assets, compatibility_date, ...).' },
      { path: 'package.json', role: 'The scripts below, @brust/core, React 19, the pinned Elysia packages, and Tailwind as dev dependencies.' },
      { path: 'README.md', role: 'How to run the app, what each file is for, and how to call the hello action.' },
      { path: '.gitignore', role: 'Keeps node_modules/, dist/, .brust/ and .wrangler/ out of git.' },
    ],
  }
}

export default function ProjectStructure({ blocks, files }: ProjectStructureData) {
  return (
    <>
      <h1>Project structure</h1>
      <Lead>A brust app is a routes file, components, an optional actions app, and a brust.toml. This is the blank template.</Lead>

      <h2 id="files">The files</h2>
      <CodeBlock code={blocks.tree.code} lang={blocks.tree.lang} cwd={blocks.tree.cwd} html={blocks.tree.html} />
      <p>Pick a file to see what it does.</p>
      <Frame title="Live demo" label="FileTree · native">
          <FileTree files={files} />
        
      </Frame>
      <p>
        Only <code>routes.tsx</code> is required by name, and you can pass another entry to <code>brust build</code>. The <code>components/</code> and <code>pages/</code> split is a convention: the compiler follows imports, not folders.
      </p>

      <h2 id="scripts">The scripts</h2>
      <CodeBlock code={blocks.scripts.code} lang={blocks.scripts.lang} file={blocks.scripts.file} html={blocks.scripts.html} />
      {/* source: packages/brust/src/cli.ts:12 (brust dev: proxy + hot reload) and packages/brust/src/dev/bun.ts:106 (it builds into .brust/dev) */}
      <p>
        <code>dev</code> runs <code>brust dev</code>: it builds into <code>.brust/dev</code>, starts the server and rebuilds when you save, see <a href="/docs/dev-mode">Dev mode</a>. The <code>:cf</code> scripts target Cloudflare Workers, see{' '}
        <a href="/docs/deployment">Deployment</a>. <code>tailwindcss</code>, <code>@tailwindcss/node</code> and <code>@tailwindcss/oxide</code> are pinned dev dependencies at one version: the build uses them, the server does not.
      </p>

      <h2 id="dist">What brust build writes</h2>
      <CodeBlock code={blocks.dist.code} lang={blocks.dist.lang} cwd={blocks.dist.cwd} html={blocks.dist.html} />
      <p>
        The build writes to a temporary folder next to <code>dist/</code> and swaps it in only when it succeeds, so a failed build leaves the last good one in place. Each page links the CSS its layout and page import from <code>client/</code> in <code>&lt;head&gt;</code>; no JS bundle carries CSS. <code>dist/</code> imports <code>react</code> and <code>@brust/core</code> at runtime: keep it inside the app, next to its <code>node_modules</code>.
      </p>
    </>
  )
}
