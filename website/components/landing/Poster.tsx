// The hero's dusk poster with the playable `$ brust build` button (native): a click lights the towers like a build, then types the CLI's line.
import { useState } from 'react'
import PosterScene from './PosterScene'

// Real: `brust build routes.tsx` of the create-app blank template, warm, 4 of 5 runs (lead, 2026-10-13, M1 Pro).
const BUILT = 'BUILT DIST IN 16MS · 3 TIERS'

export default function Poster() {
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('REACT IN · HTML OUT')
  const [live, setLive] = useState('')
  return (
    <div className="relative w-[min(100%,24rem)] justify-self-end max-wide:w-[min(100%,20rem)] max-wide:justify-self-center motion-safe:animate-mirai-reveal" style={{ '--d': '.15s' }}>
      <svg className="group/orb block aspect-[400/480] h-auto w-full outline outline-1 outline-offset-[6px] outline-rule" id="orb" viewBox="0 0 400 480" role="img" aria-label="A flat dusk scene: a sun setting behind mountains, three towers on the horizon" focusable="false">
        <defs>
          <clipPath id="poster-clip">
            <rect width="400" height="480" rx="2" />
          </clipPath>
        </defs>
        <g clipPath="url(#poster-clip)">
          <PosterScene />
          <text x="384" y="469" className="fill-pz-sun font-mono text-[10px] font-semibold tracking-[.12em]" textAnchor="end" id="poster-status">
            {status}
          </text>
        </g>
      </svg>
      <button
        type="button"
        className="absolute bottom-[.9%] left-[3.2%] inline-flex h-[4.6%] cursor-pointer items-center gap-[.45rem] rounded-xs border border-pz-sun bg-transparent px-[.7rem] font-mono text-[10.5px] font-bold tracking-[.08em] text-pz-sun hover:bg-pz-sun hover:text-pz-ink focus-visible:bg-pz-sun focus-visible:text-pz-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pz-sun aria-busy:cursor-progress aria-busy:opacity-70 motion-safe:transition-[background-color,color] motion-safe:duration-200"
        id="build-btn"
        aria-describedby="build-live"
        aria-busy={busy ? 'true' : undefined}
        onClick={() => {
          if (busy) return
          setBusy(true)
          // classList, not a class binding: the native runtime assigns `.className`, which is read-only on an SVG element.
          document.getElementById('orb')?.classList.remove('lit', 'flash')
          setLive('')
          setStatus('BUILDING…')
          const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
          setTimeout(
            () => {
              document.getElementById('orb')?.classList.add('lit', 'flash')
              const finish = () => {
                setBusy(false)
                setLive('Built dist in 16 milliseconds: static, native and react.')
              }
              if (reduce) {
                setStatus(BUILT)
                finish()
                return
              }
              let i = 0
              const id = setInterval(() => {
                i += 1
                setStatus(BUILT.slice(0, i))
                if (i >= BUILT.length) {
                  clearInterval(id)
                  finish()
                }
              }, 28)
            },
            reduce ? 0 : 450,
          )
        }}
      >
        <span aria-hidden="true">$</span> brust build
      </button>
      <span className="sr-only" id="build-live" aria-live="polite">
        {live}
      </span>
    </div>
  )
}
