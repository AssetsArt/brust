// The native tier panel: CatchCard's source beside the live card (two signals, no React on the page).
import type { CodeBlockData } from '../../lib/highlight'
import CodeBlock from '../CodeBlock'
import CatchCard from './demos/CatchCard'
import type { CatchData } from './demoData'
import Pipe from './Pipe'
import ShipBar from './ShipBar'
import UrlBar from './UrlBar'

export default function NativePanel({ code, card }: { code: CodeBlockData; card: CatchData }) {
  return (
    <div className="pt-7 [&.enter]:motion-safe:animate-mirai-enter" role="tabpanel" id="p-native" aria-labelledby="tab-native" hidden>
      <Pipe file="CatchCard.tsx" tier="native" />
      <div className="grid grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] items-stretch gap-5 max-wide:grid-cols-1 [&_pre]:max-h-[30rem] [&_pre]:overflow-auto">
        <CodeBlock code={code.code} lang={code.lang} file={code.file} cwd={code.cwd} html={code.html} />
        <div className="flex min-w-0 flex-col overflow-hidden rounded-xs border border-rule bg-sheet">
          <UrlBar url="127.0.0.1:1337/pokemon/pikachu" label="Rendered · try it" />
          <CatchCard no={card.no} name={card.name} art={card.art} shinyArt={card.shinyArt} />
          {/* Measured 2026-10-13 (gzip -9): runtime-dom 5.9 KB, the CatchCard chunk 0.6 KB. */}
          <ShipBar a={{ k: 'HTML', v: 'rendered on the server' }} b={{ k: 'JavaScript', v: 'brust runtime 6 KB + this card under 1 KB, gzipped' }} c={{ k: 'React', v: 'not loaded', no: true }} />
        </div>
      </div>
    </div>
  )
}
