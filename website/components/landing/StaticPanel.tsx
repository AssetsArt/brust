// The static tier panel: PokemonCard's source beside three of them rendered (no JavaScript, no hydration).
import type { CodeBlockData } from '../../lib/highlight'
import Code from './Code'
import PokemonCard from './demos/PokemonCard'
import type { CardData } from './demoData'
import Pipe from './Pipe'

export default function StaticPanel({ code, a, b, c }: { code: CodeBlockData; a: CardData; b: CardData; c: CardData }) {
  return (
    <div className="panel cr" role="tabpanel" id="p-static" aria-labelledby="tab-static">
      <Pipe file="PokemonCard.tsx" tier="static" />
      <div className="cr-grid">
        <Code b={code} />
        <div className="browser">
          <div className="url">
            <span>127.0.0.1:1337/pokedex</span>
            <span className="lbl">Rendered</span>
          </div>
          <div className="vp">
            <div className="cards">
              <PokemonCard no={a.no} name={a.name} types={a.types} art={a.art} />
              <PokemonCard no={b.no} name={b.name} types={b.types} art={b.art} />
              <PokemonCard no={c.no} name={c.name} types={c.types} art={c.art} />
            </div>
          </div>
          <dl className="shipbar">
            <div>
              <dt>HTML</dt>
              <dd>rendered on the server</dd>
            </div>
            <div>
              <dt>JavaScript</dt>
              <dd className="no">none</dd>
            </div>
            <div>
              <dt>Hydration</dt>
              <dd className="no">none</dd>
            </div>
          </dl>
        </div>
      </div>
    </div>
  )
}
