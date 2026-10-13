// Introduction — what brust is, how a request is served, and the three tiers, with a live native demo.
import CodeBlock from '../../components/CodeBlock'
import CatchCard from '../../components/landing/demos/CatchCard'
import { type CodeBlockData, codeBlock } from '../../lib/highlight'
import type { TocItem } from '../../lib/nav'
import { artworkUrl, byId, dexNo, displayName, shinyUrl } from '../../lib/pokemon'

export interface IntroductionData {
  toc: TocItem[]
  blocks: Record<'card', CodeBlockData>
  demo: { no: string; name: string; type: string; art: string; shinyArt: string }
}

const CARD = `import { useState } from 'react'

export default function CatchCard({ no, name, art, shinyArt }) {
  const [caught, setCaught] = useState(0)
  const [shiny, setShiny] = useState(false)
  return (
    <article className="catch">
      <img src={shiny ? shinyArt : art} alt={name} />
      <h4>{no} {name}</h4>
      <label>
        <input type="checkbox" checked={shiny} onChange={(e) => setShiny(e.target.checked)} />
        Shiny
      </label>
      <button onClick={() => setCaught(caught + 1)}>Catch · {caught}</button>
    </article>
  )
}`

export async function introductionLoader(): Promise<IntroductionData> {
  const p = byId(25)!
  return {
    toc: [
      { id: 'what', title: 'What brust is' },
      { id: 'request', title: 'How a request is served' },
      { id: 'tiers', title: 'One component, three outputs' },
      { id: 'next', title: 'Where to go next' },
    ],
    blocks: { card: codeBlock({ lang: 'tsx', file: 'components/CatchCard.tsx', code: CARD }) },
    demo: { no: dexNo(p.id), name: displayName(p.name), type: p.types[0]!, art: artworkUrl(p.id), shinyArt: shinyUrl(p.id) },
  }
}

export default function Introduction({ blocks, demo }: IntroductionData) {
  return (
    <>
      <h1>Introduction</h1>
      <p className="lead">
        Write React. Get a native page: HTML rendered by Rust from a compiled template, interactivity as a small React-free chunk, React only where the compiler proves it is needed.
      </p>

      <h2 id="what">What brust is</h2>
      <p>
        brust is a web framework for Bun. You write pages as ordinary React components and map them to paths in <code>routes.tsx</code>. <code>brust build</code> compiles every component ahead of time; <code>brust start</code> runs a Rust server (hyper on tokio) that serves the pages, with a pool of Bun workers for the code that has to run in JavaScript: your loaders, your actions, and the React islands.
      </p>
      <p>
        There are no directives to write. No <code>'use client'</code>, no <code>'use server'</code>: the compiler reads each component and decides how it is served. A leftover <code>'use client'</code> is ignored with a warning.
      </p>

      <h2 id="request">How a request is served</h2>
      <ol>
        <li>Rust receives the request and matches the route.</li>
        <li>If the route is cached and the entry is fresh, Rust answers from memory (<code>x-brust-cache: HIT</code>) without calling Bun.</li>
        <li>Otherwise the route's loaders run in a Bun worker, root to leaf, and their results are merged into one object.</li>
        <li>Components that need JavaScript on the server (a computed value, a React island's HTML) run as jobs in the same worker call; Rust caches their results per component.</li>
        <li>Rust renders the compiled templates, leaf first, each into its layout's <code>Outlet</code>, and adds only the scripts the page needs.</li>
      </ol>
      <p>A page whose jobs are all cached, or that has no loader and no jobs, is served without waking Bun at all.</p>

      <h2 id="tiers">One component, three outputs</h2>
      <p>
        The compiler gives each component one of three tiers. <span className="tier static">static</span> components read props and render markup: nothing ships to the browser. <span className="tier native">native</span> components use local state, effects and handlers: they ship a small React-free chunk. <span className="tier react">react</span> components need the real thing and become React islands. The card below is a native component on this page; its source is next to it.
      </p>
      <div className="browser">
        <div className="url">
          <span>Live demo</span>
          <span className="lbl">CatchCard · native</span>
        </div>
        <CatchCard no={demo.no} name={demo.name} art={demo.art} shinyArt={demo.shinyArt} />
      </div>
      <CodeBlock code={blocks.card.code} lang={blocks.card.lang} file={blocks.card.file} html={blocks.card.html} />
      <p>
        The live card is the landing page's CatchCard (it also logs each signal write). <code>useState</code>, a controlled checkbox and a click handler are all native-tier features, so this card ships no React. The <a href="/docs/rendering-tiers">Rendering tiers</a> page lists what lands where.
      </p>

      <h2 id="next">Where to go next</h2>
      <ul>
        <li>
          <a href="/docs/installation">Installation</a>: requirements and the project generator.
        </li>
        <li>
          <a href="/docs/quickstart">Quickstart</a>: from an empty folder to a served page in four steps.
        </li>
        <li>
          <a href="/docs/rendering-tiers">Rendering tiers</a>: static, native and react, and how to see which one you got.
        </li>
      </ul>
    </>
  )
}
