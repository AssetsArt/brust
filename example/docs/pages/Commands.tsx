import { Info } from 'lucide-react'
import CodeBlock from '../components/CodeBlock'

export default function Commands({
  devHtml,
  buildHtml,
  startHtml,
}: {
  devHtml: string
  buildHtml: string
  startHtml: string
}) {
  return (
    <article className="b-prose">
      <header className="b-pagehead">
        <p className="b-eyebrow">Getting Started</p>
        <h1>Dev &amp; build</h1>
        <p className="b-lead">
          Three commands cover the whole lifecycle: develop, build, and serve. They map to the CLI
          verbs <code>dev</code> and <code>build</code>, plus running the bundled output.
        </p>
      </header>

      <h2 id="dev">Development</h2>
      <p>
        The dev server compiles native routes on the fly, hot-reloads islands, and rebuilds the
        action client when your API changes.
      </p>
      <CodeBlock native html={devHtml} lang="bash" />

      <h2 id="build">Production build</h2>
      <p>
        The build compiles native routes to templates ahead of time, bundles island and directive
        chunks, builds the MCP manifest, and emits a self-contained <code>dist/</code>.
      </p>
      <CodeBlock native html={buildHtml} lang="bash" />

      <h2 id="start">Serve</h2>
      <CodeBlock native html={startHtml} lang="bash" />

      <div className="b-callout b-callout--info">
        <span className="b-callout__ic">
          <Info size={18} />
        </span>
        <div className="b-callout__body">
          <p className="b-callout__title">What ends up in dist/</p>
          <p>
            The build output is a single directory: compiled templates, island and directive chunks,
            the MCP manifest, the bundled server, and the static <code>public/</code> tree. Copy it
            into a container and run it — see <a href="/docs/deployment">Deployment</a>.
          </p>
        </div>
      </div>
    </article>
  )
}
