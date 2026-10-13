// Routing — defineRoutes, path params, the catch-all, nested layouts and Outlet, with a live route matcher.
import CodeBlock from '../../components/CodeBlock'
import Note from '../../components/docs/Note'
import RouteMatcher from '../../components/demos/RouteMatcher'
import { type CodeBlockData, codeBlock } from '../../lib/highlight'
import type { TocItem } from '../../lib/nav'
import Frame from '../../components/docs/Frame'
import Lead from '../../components/docs/Lead'

export interface RoutingData {
  toc: TocItem[]
  blocks: Record<'routes' | 'layout' | 'fields', CodeBlockData>
}

const ROUTES = `import { defineRoutes } from '@brust/core/routes'
import AppLayout from './components/AppLayout'
import BrowsePage from './pages/BrowsePage'
import DetailPage from './pages/DetailPage'
import HomePage from './pages/HomePage'
import NotFoundPage from './pages/NotFoundPage'

export const routes = defineRoutes([
  {
    Component: AppLayout,
    children: [
      { path: '/', Component: HomePage },
      { path: '/pokedex', Component: BrowsePage },
      { path: '/pokemon/{name}', Component: DetailPage },
    ],
  },
  { path: '*', Component: NotFoundPage },
])`

const LAYOUT = `import { Outlet } from '@brust/core/routes'

export default function AppLayout() {
  return (
    <html lang="en">
      <head>
        <title>Pokédex</title>
      </head>
      <body>
        <nav><a href="/pokedex">Pokédex</a></nav>
        <main>
          <Outlet />
        </main>
      </body>
    </html>
  )
}`

const FIELDS = `interface Route {
  path?: string                 // '/pokemon/{name}', or '*' at the root
  Component?: ComponentType
  loader?: (ctx) => data        // see Loaders and params
  cache?: RouteCacheConfig      // see Caching
  children?: Route[]            // makes this route a layout
}`

export async function routingLoader(): Promise<RoutingData> {
  return {
    toc: [
      { id: 'routes', title: 'Map paths to components' },
      { id: 'try', title: 'Try a path' },
      { id: 'params', title: 'Params and the catch-all' },
      { id: 'nonascii', title: 'Paths beyond ASCII' },
      { id: 'layouts', title: 'Layouts and Outlet' },
      { id: 'rules', title: 'What the build checks' },
    ],
    blocks: {
      routes: codeBlock({ lang: 'tsx', file: 'routes.tsx', code: ROUTES }),
      layout: codeBlock({ lang: 'tsx', file: 'components/AppLayout.tsx', code: LAYOUT }),
      fields: codeBlock({ lang: 'ts', file: '@brust/core/routes', code: FIELDS }),
    },
  }
}

export default function Routing({ blocks }: RoutingData) {
  return (
    <>
      <h1>Routing</h1>
      <Lead>One file, routes.tsx, maps paths to components. Routes nest: a route with children is a layout.</Lead>

      <h2 id="routes">Map paths to components</h2>
      <p>
        <code>defineRoutes</code> checks the tree and returns it. These are the pokedex example's routes:
      </p>
      <CodeBlock code={blocks.routes.code} lang={blocks.routes.lang} file={blocks.routes.file} html={blocks.routes.html} />
      <p>A route has five fields, and only these five: anything else fails the build.</p>
      <CodeBlock code={blocks.fields.code} lang={blocks.fields.lang} file={blocks.fields.file} html={blocks.fields.html} />

      <h2 id="try">Try a path</h2>
      <p>The matcher below runs the routes above in the browser: type a path and see which route answers it, with the decoded params.</p>
      <Frame title="Live demo" label="RouteMatcher · native">
          <RouteMatcher initialPath="/pokemon/mr%20mime" initialPattern="/pokemon/{name}" initialParams={['name = "mr mime"']} />
        
      </Frame>

      <h2 id="params">Params and the catch-all</h2>
      <ul>
        <li>
          A segment in braces, <code>{'{name}'}</code>, is a param. The loader gets it decoded: <code>%20</code> becomes a space and <code>%2F</code> becomes <code>/</code>, while <code>+</code> stays a plus. A value with a broken <code>%</code> sequence is passed raw.
        </li>
        <li>
          <code>'*'</code> is the catch-all. It is allowed once, at the root, and it renders with status <strong>404</strong>. Without one, an unknown path gets a plain 404.
        </li>
        <li>
          Two routes that differ only in a param name, such as <code>/a/{'{id}'}</code> and <code>/a/{'{slug}'}</code>, are the same route: the build fails with <code>duplicate-route</code>.
        </li>
      </ul>

      <h2 id="nonascii">Paths beyond ASCII</h2>
      {/* source: crates/brust-core/src/routing/routes.rs:407-408 and :483-488 (patterns and request paths are normalised to the browser's
          percent-encoding, UTF-8 and uppercase hex, and never decoded, so %2F inside a param stays a literal slash); :225 (the match happens in that
          form); tests/server/nonascii.chromium.test.ts:76-95 (encoded, lowercase-hex and raw-UTF-8 requests all answer 200 and share one cache entry). */}
      <p>
        A literal path may contain any character: <code>{`{ path: '/café' }`}</code> matches what a browser sends, <code>/caf%C3%A9</code>. The build stores the pattern in that encoded form and
        normalises every request path the same way (lowercase hex is uppercased, raw UTF-8 is encoded) before matching, so <code>/café</code>, <code>/caf%c3%a9</code> and <code>/caf%C3%A9</code> are one
        route and one cache entry. The path is never decoded before matching: <code>%2F</code> inside a param stays a literal slash in the param's value, and a loader still gets the
        decoded value in <code>params</code>.
      </p>

      <h2 id="layouts">Layouts and Outlet</h2>
      <p>
        A route with <code>children</code> is a layout. It can leave out <code>path</code>, which adds no prefix. Its component renders <code>&lt;Outlet/&gt;</code> where the matched child goes. The outermost layout returns the whole document.
      </p>
      <CodeBlock code={blocks.layout.code} lang={blocks.layout.lang} file={blocks.layout.file} html={blocks.layout.html} />
      <Note>
        A layout must stay static or native. <code>&lt;Outlet/&gt;</code> inside a component that compiles to a React island fails with <code>outlet-in-react</code>, and an <code>Outlet</code> in a component that is not a layout route fails with <code>outlet-outside-layout</code>.
      </Note>

      <h2 id="rules">What the build checks</h2>
      <table>
        <thead>
          <tr>
            <th>Rule</th>
            <th>When</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>route-config</code>
            </td>
            <td>An unknown field, a leaf without <code>path</code> or <code>Component</code>, a bad <code>cache</code>.</td>
          </tr>
          <tr>
            <td>
              <code>duplicate-route</code>
            </td>
            <td>Two routes match the same paths.</td>
          </tr>
          <tr>
            <td>
              <code>nested-catch-all</code>
            </td>
            <td>
              <code>'*'</code> below the root.
            </td>
          </tr>
          <tr>
            <td>
              <code>duplicate-catch-all</code>
            </td>
            <td>
              More than one <code>'*'</code>.
            </td>
          </tr>
        </tbody>
      </table>
    </>
  )
}
