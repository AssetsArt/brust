// "Sixty seconds to a served page": a numbered rail whose fill follows the scroll.
import type { CodeBlockData } from '../../lib/highlight'
import Code from './Code'
import RailFill from './RailFill'

export default function Steps({ create, write, run }: { create: CodeBlockData; write: CodeBlockData; run: CodeBlockData }) {
  return (
    <section className="sec">
      <div className="wrap">
        <div className="head">
          <h2>Sixty seconds to a served page</h2>
          <p>No config to write first. The template already has a layout, a page and the scripts.</p>
        </div>
        <ol className="rail" id="rail">
          <RailFill />
          <li>
            <span className="num">1</span>
            <div>
              <h3>Create</h3>
              <p>One command scaffolds the project and installs its dependencies.</p>
            </div>
            <Code b={create} />
          </li>
          <li>
            <span className="num">2</span>
            <div>
              <h3>Write</h3>
              <p>A page is a React component. There is nothing to import from brust.</p>
            </div>
            <Code b={write} />
          </li>
          <li>
            <span className="num">3</span>
            <div>
              <h3>Run</h3>
              <p>Build compiles every component; start serves them from Rust.</p>
            </div>
            <Code b={run} />
          </li>
        </ol>
      </div>
    </section>
  )
}
