// Demo, native tier: the Loaders page's `?pokemon=` lookup, run in the browser (this site is a static export, plan
// R7). It reads ?pokemon= from the address when it mounts, and each button runs the same lookup as the page loader
// snippet (loader-lookup.ts over lib/pokemon.ts), repaints the card and rewrites the shown URL with replaceState.
import { useEffect, useRef, useState } from 'react'
import { type Lookup, lookup } from './loader-lookup'

export default function LoaderDemo({ initial, names }: { initial: Lookup; names: string[] }) {
  const root = useRef<HTMLDivElement>(null)
  const [demo, setDemo] = useState(initial)
  // mounted marker for tests, one microtask late like the other demos (gap G9)
  useEffect(() => {
    const q = new URLSearchParams(location.search).get('pokemon')
    if (q !== null) setDemo(lookup(q))
    queueMicrotask(() => root.current?.setAttribute('data-ready', ''))
  }, [])
  return (
    <div className="loader-demo">
      <div className="browser">
        <div className="url">
          <span>/docs/loaders?pokemon={demo.query}</span>
          <span className="lbl">LoaderDemo · native</span>
        </div>
        <div className="vp" ref={root}>
          <p className="cta">
            {names.map((n) => (
              <button
                key={n}
                type="button"
                className="btn"
                onClick={() => {
                  setDemo(lookup(n))
                  history.replaceState(null, '', `?pokemon=${n}#demo`)
                }}
              >
                {n}
              </button>
            ))}
          </p>
          <div className="cards">
            <article className="pk">
              <img src={demo.card.art} alt={demo.card.name} width="200" height="200" />
              <span className="no">{demo.card.no}</span>
              <h4>{demo.card.name}</h4>
              <div>
                {demo.card.types.map((t) => (
                  <span key={t} className={'ty ' + t}>
                    {t}
                  </span>
                ))}
              </div>
            </article>
          </div>
          <p className="vp-note">{demo.found ? 'Found in lib/pokemon.ts.' : 'Not in this demo set. A real route would answer notFound().'}</p>
        </div>
      </div>
    </div>
  )
}
