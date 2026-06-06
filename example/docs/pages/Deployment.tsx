import { Info } from 'lucide-react'
import CodeBlock from '../components/CodeBlock'
import type { TableData } from '../lib/tables'

export default function Deployment({
  dockerHtml,
  configHtml,
  healthHtml,
  deployTargets,
}: {
  dockerHtml: string
  configHtml: string
  healthHtml: string
  deployTargets: TableData
}) {
  return (
    <article className="b-prose">
      <header className="b-pagehead">
        <p className="b-eyebrow">Platform</p>
        <h1>Deployment</h1>
        <p className="b-lead">
          A brust build is a single <code>dist/</code> directory plus the native server addon. It
          runs on tier-1 Linux — glibc and musl — and the embedded hyper layer speaks HTTP/1.1 and
          HTTP/2.
        </p>
      </header>

      <h2 id="targets">Tier-1 targets</h2>
      <div className="b-table-wrap">
        <div className="b-table-scroll">
          <table className="b-table">
            <thead>
              <tr>
                {deployTargets.columns.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {deployTargets.rows.map((row) => (
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

      <h2 id="docker">Docker</h2>
      <p>
        Build with Bun, then run the bundled output. The prebuilt addon is selected for your
        platform at install time, so the runtime image just needs Bun and your <code>dist/</code> +{' '}
        <code>node_modules</code>.
      </p>
      <CodeBlock native html={dockerHtml} lang="bash" />

      <h2 id="config">Configuration</h2>
      <p>
        Bind address, port, and worker count come from <code>brust.toml</code>, environment
        variables, or CLI flags — env wins over the file, flags win over env.
      </p>
      <CodeBlock native html={configHtml} lang="bash" />
      <div className="b-callout b-callout--info">
        <span className="b-callout__ic">
          <Info size={18} />
        </span>
        <div className="b-callout__body">
          <p className="b-callout__title">Behind a proxy</p>
          <p>
            Running behind nginx, Caddy, or a cloud load balancer is the common path — terminate TLS
            at the edge and let brust serve HTTP to the upstream. The hyper layer negotiates HTTP/2
            over ALPN when TLS is terminated at brust.
          </p>
        </div>
      </div>

      <h2 id="health">Health checks</h2>
      <p>brust serves a liveness endpoint for orchestrators. Point your readiness probe at it.</p>
      <CodeBlock native html={healthHtml} lang="bash" />
    </article>
  )
}
