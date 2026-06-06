import { Lightbulb } from 'lucide-react'
import CodeBlock from '../components/CodeBlock'

export default function FirstRoute({
  nativeHtml,
  registerHtml,
  loaderHtml,
  runHtml,
}: {
  nativeHtml: string
  registerHtml: string
  loaderHtml: string
  runHtml: string
}) {
  return (
    <article className="b-prose">
      <header className="b-pagehead">
        <p className="b-eyebrow">Getting Started</p>
        <h1>Your first route</h1>
        <p className="b-lead">
          Routes are components plus a path. The simplest one renders to HTML in Rust and ships zero
          JavaScript.
        </p>
      </header>

      <h2 id="a-native-route">A native route</h2>
      <p>
        Create a component and add it to the route table with <code>native: true</code>. brust
        compiles the JSX to a minijinja template at build time and renders it in the Rust server —
        there's no React on the server and nothing to hydrate on the client.
      </p>
      <CodeBlock native html={nativeHtml} lang="tsx" />
      <CodeBlock native html={registerHtml} lang="tsx" />

      <div className="b-callout b-callout--tip">
        <span className="b-callout__ic">
          <Lightbulb size={18} />
        </span>
        <div className="b-callout__body">
          <p className="b-callout__title">className either way</p>
          <p>
            Native routes compile to templates, but you still author them as JSX — use{' '}
            <code>className</code> as usual. brust lowers it to the right attribute in the emitted
            HTML.
          </p>
        </div>
      </div>

      <h2 id="add-data">Add data with a loader</h2>
      <p>
        A loader runs on the server before render. Its return value is passed to the component as
        props — typed end to end.
      </p>
      <CodeBlock native html={loaderHtml} lang="tsx" />

      <h2 id="see-it">See it</h2>
      <p>Run the dev server and the route is live. Edit the file and the page reloads.</p>
      <CodeBlock native html={runHtml} lang="bash" />
      <p>
        Ready for interactivity? Promote part of the page to a{' '}
        <a href="/docs/native-interactivity">native directive component</a> or switch the whole
        route to <a href="/docs/rendering">streaming SSR</a>.
      </p>
    </article>
  )
}
