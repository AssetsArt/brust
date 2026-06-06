// Native page. Demonstrates an in-page table rendered as a `.map()` over loader
// data (native x-for SSR) — column typography handled by CSS nth-child.
import type { TableData } from '../lib/tables'
import CodeBlock from '../components/CodeBlock'

export default function ProjectStructure({
  treeHtml,
  tomlHtml,
  keyFiles,
}: {
  treeHtml: string
  tomlHtml: string
  keyFiles: TableData
}) {
  return (
    <article className="b-prose">
      <header className="b-pagehead">
        <p className="b-eyebrow">Getting Started</p>
        <h1>Project structure</h1>
        <p className="b-lead">
          A brust app is a normal Bun project with one entry file. There's no magic file-system
          router unless you opt into one — routes are declared explicitly.
        </p>
      </header>

      <h2 id="layout">The default layout</h2>
      <CodeBlock native html={treeHtml} lang="bash" />

      <h2 id="key-files">Key files</h2>
      <div className="b-table-wrap">
        <div className="b-table-scroll">
          <table className="b-table">
            <thead>
              <tr>
                {keyFiles.columns.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {keyFiles.rows.map((row) => (
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

      <h2 id="config">brust.toml</h2>
      <p>
        Configuration is optional. Without a <code>brust.toml</code> brust binds{' '}
        <code>localhost:1337</code> with one render worker per core. Environment variables (
        <code>BRUST_PORT</code>, <code>BRUST_WORKERS</code>) and CLI flags override the file.
      </p>
      <CodeBlock native html={tomlHtml} lang="bash" />
    </article>
  )
}
