import { Info, Lightbulb } from 'lucide-react'
import CodeBlock from '../components/CodeBlock'
import Example from '../components/Example'
import Playground from '../components/Playground'

export default function Actions({
  defineHtml,
  clientHtml,
  validationHtml,
  sseHtml,
  wsHtml,
  playgroundHtml,
}: {
  defineHtml: string
  clientHtml: string
  validationHtml: string
  sseHtml: string
  wsHtml: string
  playgroundHtml: string
}) {
  return (
    <article className="b-prose">
      <header className="b-pagehead">
        <p className="b-eyebrow">Core concepts</p>
        <h1>Actions &amp; API</h1>
        <p className="b-lead">
          <code>defineActions</code> turns server functions into endpoints. A type-only client
          infers the whole API from your server file — no codegen, no schema sharing, no drift.
        </p>
      </header>

      <h2 id="define-actions">defineActions</h2>
      <p>
        Declare your API as chained handlers. Each <code>.get()</code> / <code>.post()</code>{' '}
        becomes a route under the action prefix and, with MCP on, an{' '}
        <a href="/docs/agents">agent tool</a>. The handler's return type and zod body are the
        contract.
      </p>
      <CodeBlock native html={defineHtml} lang="tsx" />

      <h2 id="client">The typed client</h2>
      <p>
        On the client, <code>client&lt;typeof actions&gt;()</code> returns a proxy that mirrors your
        action tree. TypeScript already knows the body shape and the return type — inferred straight
        from the server module's <em>type</em>, never its code.
      </p>
      <CodeBlock native html={clientHtml} lang="tsx" />

      <h2 id="playground">Live playground</h2>
      <p>
        A real round-trip: the button below calls <code>POST /_brust/action/echo</code> — a real
        brust action that is also an MCP tool — through the treaty client and renders the{' '}
        <code>{'{ data, error, status }'}</code> envelope.
      </p>
      <Example native title="POST /echo · treaty client" codeHtml={playgroundHtml}>
        <Playground native />
      </Example>
      <div className="b-callout b-callout--info">
        <span className="b-callout__ic">
          <Info size={18} />
        </span>
        <div className="b-callout__body">
          <p className="b-callout__title">Every call returns the same envelope</p>
          <p>
            Actions never throw on a non-2xx. You always get{' '}
            <code>{'{ data, error, status, headers }'}</code> — check <code>error</code>, read{' '}
            <code>data</code>. The envelope is typed so a narrowed <code>error === null</code> makes{' '}
            <code>data</code> non-null.
          </p>
        </div>
      </div>

      <h2 id="validation">Body validation with zod</h2>
      <p>
        Pass a zod schema as <code>body</code> and brust validates before your handler runs. Invalid
        input is rejected with a <code>422</code> and a typed error envelope — your handler only
        ever sees parsed, well-formed data.
      </p>
      <CodeBlock native html={validationHtml} lang="tsx" />

      <h2 id="sse">Server-sent events</h2>
      <p>
        For one-way streams — deploy logs, progress, live metrics — a route can return an SSE stream
        directly. brust sends the <code>text/event-stream</code> headers and a heartbeat for you.
      </p>
      <CodeBlock native html={sseHtml} lang="tsx" />

      <h2 id="websockets">WebSockets</h2>
      <p>
        For duplex connections, a route accepts WebSocket upgrades. The Rust layer owns the socket;
        your <code>open</code> / <code>message</code> / <code>close</code> handlers are plain
        TypeScript.
      </p>
      <CodeBlock native html={wsHtml} lang="tsx" />
      <div className="b-callout b-callout--tip">
        <span className="b-callout__ic">
          <Lightbulb size={18} />
        </span>
        <div className="b-callout__body">
          <p className="b-callout__title">One source of truth</p>
          <p>
            Actions, their MCP tools, and the typed client all derive from one server file. There's
            one type to keep in sync — and the compiler keeps it for you.
          </p>
        </div>
      </div>
    </article>
  )
}
