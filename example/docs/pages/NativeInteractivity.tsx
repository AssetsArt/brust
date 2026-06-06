// Native page. Two live demos (Counter, Clock) inside <Example> cards + two
// reference tables. The demos are REAL native directive components — every
// interaction below runs with zero React.
import { Info, Lightbulb } from 'lucide-react'
import Clock from '../components/Clock'
import CodeBlock from '../components/CodeBlock'
import Counter from '../components/Counter'
import Example from '../components/Example'
import type { TableData } from '../lib/tables'

export default function NativeInteractivity({
  directivesHtml,
  counterHtml,
  clockHtml,
  chunksHtml,
  directiveRef,
  ctxMembers,
}: {
  directivesHtml: string
  counterHtml: string
  clockHtml: string
  chunksHtml: string
  directiveRef: TableData
  ctxMembers: TableData
}) {
  return (
    <article className="b-prose">
      <header className="b-pagehead">
        <p className="b-eyebrow">Core concepts</p>
        <h1>Native interactivity</h1>
        <p className="b-lead">
          You don't need React for a toggle. brust ships a tiny react-free runtime driven by{' '}
          <code>x-*</code> directives — markup-level reactivity that works inside native routes.
        </p>
      </header>

      <h2 id="directives">The x-* directives</h2>
      <p>
        Directives are attributes the brust runtime reads at hydration. A component becomes
        interactive by declaring local state with a co-located <code>behavior</code> and binding it
        to the DOM. The runtime is a few kilobytes and loads only on pages that use it.
      </p>
      <CodeBlock native html={directivesHtml} lang="tsx" />

      <Example native title="Counter · native directive" codeHtml={counterHtml}>
        <Counter native />
      </Example>

      <h3 id="directive-reference">Directive reference</h3>
      <div className="b-table-wrap">
        <div className="b-table-scroll">
          <table className="b-table">
            <thead>
              <tr>
                {directiveRef.columns.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {directiveRef.rows.map((row) => (
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
          <p className="b-callout__title">Two syntaxes, one meaning</p>
          <p>
            Native routes compile to templates, so brust accepts both the colon form (
            <code>x-on:click</code>) and the dash form (<code>x-on-click</code>). They compile
            identically.
          </p>
        </div>
      </div>

      <h2 id="behavior">Co-located behavior</h2>
      <p>
        For real logic, export a <code>behavior</code> from the same file. It runs once per mounted
        instance with a context object — think of it as the component's controller, with{' '}
        <code>useEffect</code> semantics but no React. The clock below starts an interval in{' '}
        <code>ctx.effect()</code> and tears it down in <code>ctx.onCleanup()</code>.
      </p>

      <Example native title="Clock · ctx.effect + ctx.onCleanup" codeHtml={clockHtml}>
        <Clock native />
      </Example>

      <h3 id="ctx">The ctx object</h3>
      <div className="b-table-wrap">
        <div className="b-table-scroll">
          <table className="b-table">
            <thead>
              <tr>
                {ctxMembers.columns.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ctxMembers.rows.map((row) => (
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

      <div className="b-callout b-callout--tip">
        <span className="b-callout__ic">
          <Lightbulb size={18} />
        </span>
        <div className="b-callout__body">
          <p className="b-callout__title">effect() ≈ useEffect</p>
          <p>
            <code>ctx.effect()</code> tracks the reactive values it reads and re-runs when they
            change — the dependency array is automatic. <code>ctx.onCleanup()</code> is the function
            you'd return from <code>useEffect</code>.
          </p>
        </div>
      </div>

      <h2 id="chunks">On-demand chunks</h2>
      <p>
        Each interactive component compiles to its own chunk. brust injects a marker where it's used
        and fetches the chunk when the element is about to matter — on view, or eagerly if you ask.
        A page with one toggle downloads one toggle's worth of JavaScript.
      </p>
      <CodeBlock native html={chunksHtml} lang="tsx" />
    </article>
  )
}
