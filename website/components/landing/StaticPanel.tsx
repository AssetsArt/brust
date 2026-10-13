// The static tier panel: PokemonCard's source beside three of them rendered (no JavaScript, no hydration).
import type { CodeBlockData } from '../../lib/highlight'
import CodeBlock from '../CodeBlock'
import PokemonCard from './demos/PokemonCard'
import type { CardData } from './demoData'
import Pipe from './Pipe'
import ShipBar from './ShipBar'
import UrlBar from './UrlBar'

export default function StaticPanel({ code, a, b, c }: { code: CodeBlockData; a: CardData; b: CardData; c: CardData }) {
  return (
    <div className="pt-7 [&.enter]:motion-safe:animate-mirai-enter" role="tabpanel" id="p-static" aria-labelledby="tab-static">
      <Pipe file="PokemonCard.tsx" tier="static" />
      <div className="grid grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] items-stretch gap-5 max-wide:grid-cols-1 [&_pre]:max-h-[30rem] [&_pre]:overflow-auto">
        <CodeBlock code={code.code} lang={code.lang} file={code.file} cwd={code.cwd} html={code.html} />
        <div className="flex min-w-0 flex-col overflow-hidden rounded-xs border border-rule bg-sheet">
          <UrlBar url="127.0.0.1:1337/pokedex" label="Rendered" />
          <div className="min-h-60 flex-1 p-5">
            <div className="grid grid-cols-3 gap-3 max-narrow:grid-cols-2">
              <PokemonCard no={a.no} name={a.name} types={a.types} art={a.art} />
              <PokemonCard no={b.no} name={b.name} types={b.types} art={b.art} />
              <PokemonCard no={c.no} name={c.name} types={c.types} art={c.art} />
            </div>
          </div>
          <ShipBar a={{ k: 'HTML', v: 'rendered on the server' }} b={{ k: 'JavaScript', v: 'none', no: true }} c={{ k: 'Hydration', v: 'none', no: true }} />
        </div>
      </div>
    </div>
  )
}
