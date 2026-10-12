// "Data stays next to the route": the route entry and the invalidate call, with the numbered pins that tie them to the list.
import type { CodeBlockData } from '../../lib/highlight'
import Code from './Code'

export default function DataSection({ route, invalidate }: { route: CodeBlockData; invalidate: CodeBlockData }) {
  return (
    <section className="sec">
      <div className="wrap split">
        <div className="text">
          <h2>Data stays next to the route</h2>
          <p className="muted">
            Each route names its loader, and layouts nest through <code>Outlet</code> with their loader results merged top-down.
          </p>
          <ol className="pins">
            <li>
              <span className="pin">1</span>
              <span>
                <b>Params arrive decoded</b>, including encoded slashes.
              </span>
            </li>
            <li>
              <span className="pin">2</span>
              <span>
                <b>The loader runs in Bun</b> with the request in hand and returns the page's props.
              </span>
            </li>
            <li>
              <span className="pin">3</span>
              <span>
                <b>Caching is one line.</b> A hit is answered by Rust and never wakes Bun.
              </span>
            </li>
            <li>
              <span className="pin">4</span>
              <span>
                <b>Invalidate by tag</b> from wherever the data changed.
              </span>
            </li>
          </ol>
        </div>
        <div className="stack">
          <Code b={route} />
          <Code b={invalidate} />
        </div>
      </div>
    </section>
  )
}
