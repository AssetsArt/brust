import { Info, Lightbulb } from 'lucide-react'
import CodeBlock from '../components/CodeBlock'
import type { TableData } from '../lib/tables'

export default function Routing({
  defineHtml,
  outletHtml,
  paramsHtml,
  loadersHtml,
  middlewareHtml,
  navHtml,
  routeFields,
  routeStreaming,
}: {
  defineHtml: string
  outletHtml: string
  paramsHtml: string
  loadersHtml: string
  middlewareHtml: string
  navHtml: string
  routeFields: TableData
  routeStreaming: TableData
}) {
  return (
    <article className="b-prose">
      <header className="b-pagehead">
        <p className="b-eyebrow">Core concepts</p>
        <h1>Routing</h1>
        <p className="b-lead">
          Routes are declared in one place with <code>defineRoutes</code>. They nest, take dynamic
          params, run typed loaders, and navigate on the client without a full reload.
        </p>
      </header>

      <h2 id="define-routes">defineRoutes</h2>
      <p>
        The route table is a single array. Each entry pairs a <code>path</code> with a{' '}
        <code>Component</code> and, optionally, a loader, middleware, child routes, and a rendering
        mode. There is no implicit file-system routing — what you see is the whole map.
      </p>
      <CodeBlock native html={defineHtml} lang="tsx" />

      <h3 id="route-fields">Route fields</h3>
      <div className="b-table-wrap">
        <div className="b-table-scroll">
          <table className="b-table">
            <thead>
              <tr>
                {routeFields.columns.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {routeFields.rows.map((row) => (
                <tr key={row.cells[0]}>
                  {row.cells.map((cell) => (
                    <td key={cell}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <h2 id="nesting">Nested routes &amp; Outlet</h2>
      <p>
        A route with <code>children</code> is a layout. It renders shared chrome — a sidebar, a
        header — and drops the active child wherever you place <code>&lt;Outlet/&gt;</code>. Layouts
        and their children load in parallel, not in a waterfall.
      </p>
      <CodeBlock native html={outletHtml} lang="tsx" />

      <h2 id="params">Dynamic params</h2>
      <p>
        A <code>{'{param}'}</code> segment is parsed and handed to the loader. Return{' '}
        <code>notFound()</code> or <code>redirect()</code> from a native loader to short-circuit the
        render.
      </p>
      <CodeBlock native html={paramsHtml} lang="tsx" />
      <div className="b-callout b-callout--tip">
        <span className="b-callout__ic">
          <Lightbulb size={18} />
        </span>
        <div className="b-callout__body">
          <p className="b-callout__title">Verdicts, not exceptions</p>
          <p>
            Native loaders return <code>notFound()</code> / <code>redirect()</code> verdicts from{' '}
            <code>brustjs/routes</code>. brust renders the matching boundary or emits the redirect
            without rendering the route.
          </p>
        </div>
      </div>

      <h2 id="loaders">Typed loaders</h2>
      <p>
        Loaders run on the server, before render. Whatever a loader returns becomes the component's
        props, fully typed — there's no separate <code>useLoaderData</code> hook to keep in sync.
      </p>
      <CodeBlock native html={loadersHtml} lang="tsx" />

      <h2 id="middleware">Request-scoped middleware</h2>
      <p>
        Middleware is a plain typed function —{' '}
        <code>(req, next) =&gt; Promise&lt;RouteResponse&gt;</code>. It can read the request,
        short-circuit with a response, or call <code>next()</code> and return its result. Parent
        middleware runs before child.
      </p>
      <CodeBlock native html={middlewareHtml} lang="tsx" />

      <h2 id="navigation">SPA navigation</h2>
      <p>
        <code>navigate(path)</code> from <code>brustjs/navigation</code> moves on the client: brust
        fetches the next route and swaps the page's <code>&lt;main&gt;</code> content — no full
        reload. React islands can subscribe to navigation state with <code>useNav()</code>.
      </p>
      <CodeBlock native html={navHtml} lang="tsx" />

      <h3 id="streaming-routes">Streaming &amp; sockets</h3>
      <p>
        A route can also stream Server-Sent Events or accept WebSocket upgrades instead of rendering
        a component:
      </p>
      <div className="b-table-wrap">
        <div className="b-table-scroll">
          <table className="b-table">
            <thead>
              <tr>
                {routeStreaming.columns.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {routeStreaming.rows.map((row) => (
                <tr key={row.cells[0]}>
                  {row.cells.map((cell) => (
                    <td key={cell}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="b-callout b-callout--info">
        <span className="b-callout__ic">
          <Info size={18} />
        </span>
        <div className="b-callout__body">
          <p className="b-callout__title">Native routes navigate too</p>
          <p>
            A <code>native</code> route has no client runtime of its own, but a React island can
            still <code>navigate()</code> to it — brust fetches the pre-rendered HTML fragment and
            swaps it in.
          </p>
        </div>
      </div>
    </article>
  )
}
