// The hero's dusk poster with the playable `$ brust build` button (native): a click lights the towers like a build, then types the CLI's line.
import { useState } from 'react'
import PosterScene from './PosterScene'

const BUILT = 'BUILT DIST IN 17MS · 3 TIERS'

export default function Poster() {
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('REACT IN · HTML OUT')
  const [live, setLive] = useState('')
  return (
    <div className="poster rv" style={{ '--d': '.15s' }}>
      <svg className="orb" id="orb" viewBox="0 0 400 480" role="img" aria-label="A flat dusk scene: a sun setting behind mountains, three towers on the horizon" focusable="false">
        <defs>
          <clipPath id="poster-clip">
            <rect width="400" height="480" rx="2" />
          </clipPath>
        </defs>
        <g clipPath="url(#poster-clip)">
          <PosterScene />
          <text x="384" y="469" className="capt" textAnchor="end" id="poster-status">
            {status}
          </text>
        </g>
      </svg>
      <button
        type="button"
        className="build-btn"
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
                setLive('Built dist in 17 milliseconds: static, native and react.')
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
      <span className="sr" id="build-live" aria-live="polite">
        {live}
      </span>
    </div>
  )
}
