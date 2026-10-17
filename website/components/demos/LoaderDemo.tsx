// Demo, native tier: the Loaders page's `?pokemon=` lookup, run in the browser (this site is a static export, plan
// R7). It reads ?pokemon= from the address when it mounts, and each button runs the same lookup as the page loader
// snippet (loader-lookup.ts over lib/pokemon.ts), repaints the card and rewrites the shown URL with replaceState.
import { useEffect, useRef, useState } from 'react'
import { type Lookup, lookup } from './loader-lookup'

// The type pills: literal class names (so Tailwind finds them), one per type of lib/pokemon.ts and the other demos.
const TYPE_BASE = 'rounded-full px-2 py-[.05rem] font-mono text-[11px] text-white bg-ty-normal'
const TYPE: Record<string, string> = {
  grass: 'rounded-full px-2 py-[.05rem] font-mono text-[11px] text-white bg-ty-grass',
  poison: 'rounded-full px-2 py-[.05rem] font-mono text-[11px] text-white bg-ty-poison',
  fire: 'rounded-full px-2 py-[.05rem] font-mono text-[11px] text-white bg-ty-fire',
  electric: 'rounded-full px-2 py-[.05rem] font-mono text-[11px] bg-ty-electric text-ty-dark-fg',
  water: 'rounded-full px-2 py-[.05rem] font-mono text-[11px] text-white bg-ty-water',
  normal: 'rounded-full px-2 py-[.05rem] font-mono text-[11px] text-white bg-ty-normal',
  flying: 'rounded-full px-2 py-[.05rem] font-mono text-[11px] text-white bg-ty-flying',
  psychic: 'rounded-full px-2 py-[.05rem] font-mono text-[11px] text-white bg-ty-psychic',
  ghost: 'rounded-full px-2 py-[.05rem] font-mono text-[11px] text-white bg-ty-ghost',
  ice: 'rounded-full px-2 py-[.05rem] font-mono text-[11px] text-white bg-ty-ice',
  dragon: 'rounded-full px-2 py-[.05rem] font-mono text-[11px] text-white bg-ty-dragon',
  fairy: 'rounded-full px-2 py-[.05rem] font-mono text-[11px] text-white bg-ty-fairy',
}

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
      {/* `browser` is only the test hook for "this page has a demo frame" (guide.test.ts); the look is the utilities */}
      <div className="browser flex min-w-0 flex-col overflow-hidden rounded-xs border border-rule bg-sheet">
        <div className="flex justify-between gap-4 border-b border-rule bg-paper px-[.8rem] py-[.45rem] font-mono text-[12px] text-ink-2">
          <span>/docs/loaders?pokemon={demo.query}</span>
          <span className="text-amber-ink">LoaderDemo · native</span>
        </div>
        <div className="flex-1 p-5" ref={root}>
          <p className="flex flex-wrap gap-3">
            {names.map((n) => (
              <button
                key={n}
                type="button"
                className="inline-flex min-h-[46px] items-center gap-2 border border-ink bg-transparent px-[1.15rem] py-[.7rem] font-mono text-[.72rem] font-bold tracking-[.08em] text-ink uppercase no-underline motion-safe:[transition-property:translate,background-color,box-shadow] motion-safe:duration-200 motion-safe:hover:-translate-y-px"
                onClick={() => {
                  setDemo(lookup(n))
                  history.replaceState(null, '', `?pokemon=${n}#demo`)
                }}
              >
                {n}
              </button>
            ))}
          </p>
          <div className="grid grid-cols-3 gap-3 max-narrow:grid-cols-2">
            <article className="grid min-w-0 content-start gap-[.3rem] rounded-xs border border-rule bg-paper p-[.8rem]">
              <img src={demo.card.art} alt={demo.card.name} width="200" height="200" className="aspect-square h-auto w-full max-w-full rounded-md bg-sheet p-[.35rem]" />
              <span className="font-mono text-[12px] text-ink-2">{demo.card.no}</span>
              <h4 className="m-0 font-display text-[1rem]">{demo.card.name}</h4>
              <div className="flex flex-wrap gap-[.3rem]">
                {demo.card.types.map((t) => (
                  <span key={t} className={TYPE[t] ?? TYPE_BASE}>
                    {t}
                  </span>
                ))}
              </div>
            </article>
          </div>
          <p className="vp-note max-w-[68ch] text-[13.5px] text-ink-2">{demo.found ? 'Found in lib/pokemon.ts.' : 'Not in this demo set. A real route would answer notFound().'}</p>
        </div>
      </div>
    </div>
  )
}
