import { Lightbulb } from 'lucide-react'
import CodeBlock from '../components/CodeBlock'
import type { TableData } from '../lib/tables'

export default function Cli({
  devHtml,
  buildHtml,
  newHtml,
  cliCommands,
}: {
  devHtml: string
  buildHtml: string
  newHtml: string
  cliCommands: TableData
}) {
  return (
    <article className="b-prose">
      <header className="b-pagehead">
        <p className="b-eyebrow">Platform</p>
        <h1>CLI</h1>
        <p className="b-lead">
          The <code>brustjs</code> CLI has three verbs: <code>dev</code>, <code>build</code>, and{' '}
          <code>new</code>. Everything else is configuration in <code>brust.toml</code>.
        </p>
      </header>

      <h2 id="commands">Commands</h2>
      <div className="b-table-wrap">
        <div className="b-table-scroll">
          <table className="b-table">
            <thead>
              <tr>
                {cliCommands.columns.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cliCommands.rows.map((row) => (
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

      <h3 id="dev">brustjs dev</h3>
      <CodeBlock native html={devHtml} lang="bash" />

      <h3 id="build">brustjs build</h3>
      <CodeBlock native html={buildHtml} lang="bash" />

      <h2 id="new">brustjs new</h2>
      <CodeBlock native html={newHtml} lang="bash" />
      <div className="b-callout b-callout--tip">
        <span className="b-callout__ic">
          <Lightbulb size={18} />
        </span>
        <div className="b-callout__body">
          <p className="b-callout__title">Bun script aliases</p>
          <p>
            The scaffold wires <code>dev</code>, <code>build</code>, and <code>preview</code> into{' '}
            <code>package.json</code>, so <code>bun run dev</code> and <code>brustjs dev</code> do
            the same thing.
          </p>
        </div>
      </div>
    </article>
  )
}
