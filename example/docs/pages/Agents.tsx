import { Info, TriangleAlert } from 'lucide-react'
import CodeBlock from '../components/CodeBlock'

export default function Agents({
  bootHtml,
  toolsHtml,
  resourcesHtml,
}: {
  bootHtml: string
  toolsHtml: string
  resourcesHtml: string
}) {
  return (
    <article className="b-prose">
      <header className="b-pagehead">
        <p className="b-eyebrow">Platform</p>
        <h1>Agents · MCP</h1>
        <p className="b-lead">
          Every action you write is already an agent tool. brust exposes your API over the Model
          Context Protocol at <code>/_brust/mcp</code> — so an LLM drives your app through the same
          typed surface your UI uses, no scraping.
        </p>
      </header>

      <h2 id="how">How it works</h2>
      <p>
        When you build, brust reads your action tree and emits an MCP manifest, then serves it. Each{' '}
        <code>.get</code> / <code>.post</code> becomes a <strong>tool</strong> with a JSON schema
        taken from its zod body; each <a href="/docs/routing">loader</a> becomes a{' '}
        <strong>resource</strong> an agent can read. Nothing extra to write — the API you already
        shipped is the agent interface.
      </p>
      <CodeBlock native html={bootHtml} lang="tsx" />

      <h2 id="tools">Actions become tools</h2>
      <p>
        A deploy action and its zod schema turn into a tool an agent can call with validated
        arguments — the same validation your UI relies on.
      </p>
      <CodeBlock native html={toolsHtml} lang="json" />

      <h2 id="resources">Loaders become resources</h2>
      <p>
        An agent can read a route's loader output as an MCP resource — the same data your page
        renders, in structured form.
      </p>
      <CodeBlock native html={resourcesHtml} lang="json" />
      <div className="b-callout b-callout--info">
        <span className="b-callout__ic">
          <Info size={18} />
        </span>
        <div className="b-callout__body">
          <p className="b-callout__title">The app is the API is the agent</p>
          <p>
            Because UI, API, and MCP tools all derive from one action tree, they can't drift. Ship a
            feature once and your users, your typed client, and any connected agent all get it at
            the same time. (This docs site serves its own nav at <code>/_brust/action/docs</code>.)
          </p>
        </div>
      </div>
      <div className="b-callout b-callout--warning">
        <span className="b-callout__ic">
          <TriangleAlert size={18} />
        </span>
        <div className="b-callout__body">
          <p className="b-callout__title">Gate it</p>
          <p>
            MCP exposes mutations. Put write actions behind middleware auth in production — an agent
            with a deploy tool can ship to prod.
          </p>
        </div>
      </div>
    </article>
  )
}
