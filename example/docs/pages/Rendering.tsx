import { Info, Lightbulb } from 'lucide-react'
import CodeBlock from '../components/CodeBlock'
import Example from '../components/Example'
import Toggle from '../components/Toggle'
import type { TableData } from '../lib/tables'

export default function Rendering({
  streamingHtml,
  modesHtml,
  islandHtml,
  islandUseHtml,
  isrHtml,
  isrInvalidateHtml,
  toggleHtml,
  modeCompare,
}: {
  streamingHtml: string
  modesHtml: string
  islandHtml: string
  islandUseHtml: string
  isrHtml: string
  isrInvalidateHtml: string
  toggleHtml: string
  modeCompare: TableData
}) {
  return (
    <article className="b-prose">
      <header className="b-pagehead">
        <p className="b-eyebrow">Core concepts</p>
        <h1>Rendering</h1>
        <p className="b-lead">
          brust has three rendering modes that share one route table: streaming React, native Rust
          templates, and hydrated islands. Each route picks the cheapest mode that does the job.
        </p>
      </header>

      <h2 id="streaming">Streaming SSR</h2>
      <p>
        React routes render with React 19's <code>renderToPipeableStream</code>. brust wraps async
        boundaries in Suspense automatically, so the document shell flushes on the first byte and
        slow data streams in as it resolves.
      </p>
      <CodeBlock native html={streamingHtml} lang="tsx" />
      <div className="b-callout b-callout--tip">
        <span className="b-callout__ic">
          <Lightbulb size={18} />
        </span>
        <div className="b-callout__body">
          <p className="b-callout__title">Suspense for free</p>
          <p>
            Any component that reads a still-pending loader value is wrapped in an implicit Suspense
            boundary. You only write <code>&lt;Suspense&gt;</code> when you want a custom fallback.
          </p>
        </div>
      </div>

      <h2 id="native">Native routes</h2>
      <p>
        Mark a route <code>native: true</code> and brust compiles its JSX to a minijinja template at
        build time. The Rust server renders it directly — React never runs on the server, and the
        page ships no client runtime at all. This is the fastest path to HTML brust offers.
      </p>
      <CodeBlock native html={modesHtml} lang="tsx" />

      <Example native title="island vs native · the same component" codeHtml={toggleHtml}>
        <Toggle native />
      </Example>

      <h3 id="mode-compare">Choosing a mode</h3>
      <div className="b-table-wrap">
        <div className="b-table-scroll">
          <table className="b-table">
            <thead>
              <tr>
                {modeCompare.columns.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {modeCompare.rows.map((row) => (
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

      <h2 id="islands">Islands</h2>
      <p>
        An island is a component you hydrate explicitly with <code>&lt;Island&gt;</code>. brust
        bundles it as its own chunk and hydrates only that subtree on the client. The surrounding
        page stays static HTML — no framework runtime, no hydration of the whole tree.
      </p>
      <CodeBlock native html={islandHtml} lang="tsx" />
      <p>
        Drop the island anywhere — including inside a native route. brust emits a hydration marker
        and loads the chunk per the <code>hydrate</code> trigger (<code>load</code> /{' '}
        <code>visible</code> / <code>idle</code> / <code>interaction</code>).
      </p>
      <CodeBlock native html={islandUseHtml} lang="tsx" />

      <h2 id="isr">ISR caching</h2>
      <p>
        Add a <code>cache</code> to a route and brust caches its rendered HTML in the Rust layer for
        <code>ttl_seconds</code>, keyed by URL (add <code>vary</code> to split the key on a request
        header). Route caches refresh when the TTL lapses.
      </p>
      <CodeBlock native html={isrHtml} lang="tsx" />
      <p>
        Component-level renders — an <code>&lt;Island&gt;</code> with an <code>isr</code> key and
        tags — can also be evicted on demand, for example from an action after a publish:
      </p>
      <CodeBlock native html={isrInvalidateHtml} lang="tsx" />
      <div className="b-callout b-callout--info">
        <span className="b-callout__ic">
          <Info size={18} />
        </span>
        <div className="b-callout__body">
          <p className="b-callout__title">Where the cache lives</p>
          <p>
            The cache is held by the Rust layer and shared across the worker pool. It survives
            across requests within a running server.
          </p>
        </div>
      </div>
    </article>
  )
}
