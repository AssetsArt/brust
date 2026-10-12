// Cookbook: Hello world — a page, a param route with a loader, and the first curl. Code is the app that was built
// and run for this page (static tier, no client JavaScript); the curl output is real.
import CodeBlock from '../../../components/CodeBlock'
import Note from '../../../components/docs/Note'
import Step from '../../../components/docs/Step'
import { type CodeBlockData, type CodeBlockInput, codeBlock } from '../../../lib/highlight'
import type { TocItem } from '../../../lib/nav'

const SRC = {
  page: {
    lang: 'tsx',
    file: 'pages/HelloPage.tsx',
    code: `export default function HelloPage() {
  return (
    <section>
      <h1>Hello, Pikachu</h1>
      <p>Served by Rust. No client JavaScript.</p>
    </section>
  )
}`,
  },
  routes: {
    lang: 'tsx',
    file: 'routes.tsx',
    code: `import { defineRoutes } from '@brust/core/routes'
import HelloPage from './pages/HelloPage'

export const routes = defineRoutes([{ path: '/', Component: HelloPage }])`,
  },
  curl: {
    lang: 'sh',
    cwd: '~/my-app',
    code: `$ curl -i http://127.0.0.1:1337/
HTTP/1.1 200 OK
content-type: text/html; charset=utf-8
x-powered-by: brust/2.0.0-alpha.3
content-length: 87

<section><h1>Hello, Pikachu</h1><p>Served by Rust. No client JavaScript.</p></section>`,
  },
  loader: {
    lang: 'ts',
    file: 'lib/loaders.ts',
    code: `import { type LoaderCtx, notFound, type Verdict } from '@brust/core/routes'
import { byName } from './pokemon'

export async function pokemonLoader({ params }: LoaderCtx<{ name: string }>): Promise<{ name: string; id: number; types: string } | Verdict> {
  const p = byName(params.name ?? '')
  if (!p) return notFound({ name: params.name ?? '', id: 0, types: '' })
  return { name: p.name, id: p.id, types: p.types.join(' / ') }
}`,
  },
  param: {
    lang: 'tsx',
    file: 'routes.tsx',
    code: `{ path: '/pokemon/{name}', Component: PokemonPage, loader: pokemonLoader },`,
  },
  paramPage: {
    lang: 'tsx',
    file: 'pages/PokemonPage.tsx',
    code: `export default function PokemonPage({ name, id, types }: { name: string; id: number; types: string }) {
  return (
    <section>
      <h1>{name}</h1>
      <p>#{id} · {types}</p>
    </section>
  )
}`,
  },
  param_out: {
    lang: 'sh',
    cwd: '~/my-app',
    code: `$ curl -s http://127.0.0.1:1337/pokemon/pikachu
<section><h1>pikachu</h1><p>#25 · electric</p></section>
$ curl -si http://127.0.0.1:1337/pokemon/missingno | head -1
HTTP/1.1 404 Not Found`,
  },
} satisfies Record<string, CodeBlockInput>

export interface HelloWorldData {
  toc: TocItem[]
  blocks: Record<keyof typeof SRC, CodeBlockData>
}

export async function helloWorldLoader(): Promise<HelloWorldData> {
  return {
    toc: [
      { id: 'page', title: 'Write a page' },
      { id: 'run', title: 'Run it' },
      { id: 'param', title: 'Add a param route' },
    ],
    blocks: Object.fromEntries(Object.entries(SRC).map(([k, v]) => [k, codeBlock(v)])) as HelloWorldData['blocks'],
  }
}

export default function HelloWorld({ blocks }: HelloWorldData) {
  return (
    <section style={{ display: 'contents' }}>
      <h1>Hello world</h1>
      <p className="lead">The smallest app: one page, one route. Then a route with a path param and a loader.</p>

      <Step n={1} id="page" title="Write a page" />
      <p>A page is a plain React component. This one has no state and no handlers, so the compiler marks it <span className="tier static">static</span>: rendered once, served as HTML.</p>
      <CodeBlock code={blocks.page.code} lang={blocks.page.lang} file={blocks.page.file} html={blocks.page.html} />
      <CodeBlock code={blocks.routes.code} lang={blocks.routes.lang} file={blocks.routes.file} html={blocks.routes.html} />

      <Step n={2} id="run" title="Run it" />
      <p>
        <code>bun run dev</code> builds and starts the server (the <a href="/docs/quickstart">Quickstart</a> shows its output). Then ask for the page:
      </p>
      <CodeBlock code={blocks.curl.code} lang={blocks.curl.lang} cwd={blocks.curl.cwd} html={blocks.curl.html} />

      <Step n={3} id="param" title="Add a param route" />
      <p>
        A path segment in braces becomes a param. The loader reads it, looks the Pokémon up, and returns the props the page renders. A name it does not know returns <code>notFound(...)</code>, which answers 404.
      </p>
      <CodeBlock code={blocks.loader.code} lang={blocks.loader.lang} file={blocks.loader.file} html={blocks.loader.html} />
      <CodeBlock code={blocks.param.code} lang={blocks.param.lang} file={blocks.param.file} html={blocks.param.html} />
      <CodeBlock code={blocks.paramPage.code} lang={blocks.paramPage.lang} file={blocks.paramPage.file} html={blocks.paramPage.html} />
      <CodeBlock code={blocks.param_out.code} lang={blocks.param_out.lang} cwd={blocks.param_out.cwd} html={blocks.param_out.html} />
      <Note>
        Loaders have their own page: <a href="/docs/loaders">Loaders and params</a>. For the catch-all 404 document, see <a href="/docs/cookbook/static-404">Static 404 page</a>.
      </Note>
    </section>
  )
}
