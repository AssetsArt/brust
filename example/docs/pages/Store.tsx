import { Info, Lightbulb } from 'lucide-react'
import CodeBlock from '../components/CodeBlock'
import Counter from '../components/Counter'
import Example from '../components/Example'
import type { TableData } from '../lib/tables'

export default function Store({
  signalsHtml,
  defineHtml,
  singletonHtml,
  useStoreHtml,
  counterHtml,
  storePrimitives,
}: {
  signalsHtml: string
  defineHtml: string
  singletonHtml: string
  useStoreHtml: string
  counterHtml: string
  storePrimitives: TableData
}) {
  return (
    <article className="b-prose">
      <header className="b-pagehead">
        <p className="b-eyebrow">Core concepts</p>
        <h1>State — the store</h1>
        <p className="b-lead">
          <code>brustjs/store</code> is a tiny signals library: <code>signal</code>,{' '}
          <code>computed</code>, and <code>effect</code>. One store is a single <code>window</code>{' '}
          singleton, shared across every island and directive chunk on the page.
        </p>
      </header>

      <h2 id="signals">Signals</h2>
      <p>
        A signal is a reactive value. Call it to read, call <code>.set()</code> to write. Anything
        that read the signal while running re-runs when it changes — no providers, no reducers, no
        context.
      </p>
      <CodeBlock native html={signalsHtml} lang="tsx" />

      <Example native title="signal · the counter is one signal" codeHtml={counterHtml}>
        <Counter native />
      </Example>

      <h3 id="primitives">Primitives</h3>
      <div className="b-table-wrap">
        <div className="b-table-scroll">
          <table className="b-table">
            <thead>
              <tr>
                {storePrimitives.columns.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {storePrimitives.rows.map((row) => (
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

      <h2 id="define-store">defineStore</h2>
      <p>
        Group related signals and the functions that mutate them with <code>defineStore</code>. It
        returns a typed store object you can import anywhere. The first import on the page
        instantiates it; every later import — from any chunk — gets the same instance.
      </p>
      <CodeBlock native html={defineHtml} lang="tsx" />

      <h2 id="singleton">One singleton per page</h2>
      <p>
        brust hangs each store off a single key on <code>window</code>. Because islands are separate
        chunks, this matters: two islands that both import a store read and write the <em>same</em>{' '}
        state, even though they were bundled and hydrated independently.
      </p>
      <CodeBlock native html={singletonHtml} lang="tsx" />
      <div className="b-callout b-callout--info">
        <span className="b-callout__ic">
          <Info size={18} />
        </span>
        <div className="b-callout__body">
          <p className="b-callout__title">Why a window singleton</p>
          <p>
            Island chunks don't share a module graph at runtime — each is loaded on its own. The
            store keys itself on <code>window</code> by name so the cart badge in the header and the
            cart drawer in the sidebar stay in lockstep without prop-drilling or a shared bundle.
          </p>
        </div>
      </div>

      <h2 id="use-store">useStore in React islands</h2>
      <p>
        Inside a React island, <code>useStore</code> (from <code>brustjs/client</code>) subscribes a
        component to a store and re-renders it on change.
      </p>
      <CodeBlock native html={useStoreHtml} lang="tsx" />
      <div className="b-callout b-callout--tip">
        <span className="b-callout__ic">
          <Lightbulb size={18} />
        </span>
        <div className="b-callout__body">
          <p className="b-callout__title">Works outside React too</p>
          <p>
            The same store drives <code>x-*</code> native components — bind a directive to a store
            signal and it updates without React on the page at all. The store is the shared layer
            between your native routes and your React islands.
          </p>
        </div>
      </div>
    </article>
  )
}
