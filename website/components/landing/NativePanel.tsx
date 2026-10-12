// The native tier panel: CatchCard's source beside the live card (two signals, no React on the page).
import type { CodeBlockData } from '../../lib/highlight'
import Code from './Code'
import CatchCard from './demos/CatchCard'
import type { CatchData } from './demoData'
import Pipe from './Pipe'

export default function NativePanel({ code, card }: { code: CodeBlockData; card: CatchData }) {
  return (
    <div className="panel cr" role="tabpanel" id="p-native" aria-labelledby="tab-native" hidden>
      <Pipe file="CatchCard.tsx" tier="native" />
      <div className="cr-grid">
        <Code b={code} />
        <div className="browser">
          <div className="url">
            <span>127.0.0.1:1337/pokemon/pikachu</span>
            <span className="lbl">Rendered · try it</span>
          </div>
          <CatchCard no={card.no} name={card.name} art={card.art} shinyArt={card.shinyArt} />
          <dl className="shipbar">
            <div>
              <dt>HTML</dt>
              <dd>rendered on the server</dd>
            </div>
            <div>
              <dt>JavaScript</dt>
              <dd>brust runtime, about 1 KB</dd>
            </div>
            <div>
              <dt>React</dt>
              <dd className="no">not loaded</dd>
            </div>
          </dl>
        </div>
      </div>
    </div>
  )
}
