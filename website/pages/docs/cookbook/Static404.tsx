// Cookbook: Static 404 page — a catch-all route outside the layout renders a full document with HTTP 404.
// The status line is real (curl against the built app); the component compiled to the static tier.
import CodeBlock from '../../../components/CodeBlock'
import Note from '../../../components/docs/Note'
import Step from '../../../components/docs/Step'
import { type CodeBlockData, type CodeBlockInput, codeBlock } from '../../../lib/highlight'
import type { TocItem } from '../../../lib/nav'

const SRC = {
  page: {
    lang: 'tsx',
    file: 'pages/NotFoundPage.tsx',
    code: `export default function NotFoundPage() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>Not found</title>
      </head>
      <body>
        <h1>A wild 404 appeared</h1>
        <a href="/">Back to the Pokédex</a>
      </body>
    </html>
  )
}`,
  },
  routes: {
    lang: 'tsx',
    file: 'routes.tsx',
    code: `export const routes = defineRoutes([
  { Component: Layout, children: [{ path: '/', Component: HomePage }] },
  // Outside the layout on purpose: a full document, no loader, no scripts.
  { path: '*', Component: NotFoundPage },
])`,
  },
  curl: {
    lang: 'sh',
    cwd: '~/my-app',
    code: `$ curl -si http://127.0.0.1:1337/no-such-page | head -3
HTTP/1.1 404 Not Found
content-type: text/html; charset=utf-8
x-powered-by: brust/2.0.0-alpha.3`,
  },
} satisfies Record<string, CodeBlockInput>

export interface Static404Data {
  toc: TocItem[]
  blocks: Record<keyof typeof SRC, CodeBlockData>
}

export async function static404Loader(): Promise<Static404Data> {
  return {
    toc: [
      { id: 'page', title: 'Write the page' },
      { id: 'route', title: 'Add the catch-all route' },
      { id: 'check', title: 'Check the status' },
    ],
    blocks: Object.fromEntries(Object.entries(SRC).map(([k, v]) => [k, codeBlock(v)])) as Static404Data['blocks'],
  }
}

export default function Static404({ blocks }: Static404Data) {
  return (
    <section style={{ display: 'contents' }}>
      <h1>Static 404 page</h1>
      <p className="lead">Any path no route matches answers 404 with a page of your own, rendered once and served as HTML.</p>

      <Step n={1} id="page" title="Write the page" />
      <p>
        The page is a full document, <code>html</code> to <code>body</code>, because it sits outside the layout. With no state, handlers or loader it is <span className="tier static">static</span>.
      </p>
      <CodeBlock code={blocks.page.code} lang={blocks.page.lang} file={blocks.page.file} html={blocks.page.html} />

      <Step n={2} id="route" title="Add the catch-all route" />
      <p>
        A route whose path is <code>*</code> catches every request that matched nothing else, with HTTP 404. Put it last, outside the layout.
      </p>
      <CodeBlock code={blocks.routes.code} lang={blocks.routes.lang} file={blocks.routes.file} html={blocks.routes.html} />

      <Step n={3} id="check" title="Check the status" />
      <CodeBlock code={blocks.curl.code} lang={blocks.curl.lang} cwd={blocks.curl.cwd} html={blocks.curl.html} />
      <Note>
        Paths under the actions prefix are answered by the actions app, not by this page: an unknown action path is a problem+json 404. A loader can also send a 404 for a route that did match, with <code>notFound(...)</code> (see <a href="/docs/cookbook/hello-world">Hello world</a>).
      </Note>
    </section>
  )
}
