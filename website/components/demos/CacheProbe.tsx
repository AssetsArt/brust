// Demo, native tier: the Caching page's probe. This site is a static export, so the three requests go to a
// simulation of the demo route's cache rules (cache-sim.ts) and the rows show the x-brust-cache header a real
// `brust start` sends for them. The visible label says so; there are no timings, because nothing is measured.
import { useEffect, useRef, useState } from 'react'
import { demoCache } from './cache-sim'

export default function CacheProbe({ names }: { names: string[] }) {
  const root = useRef<HTMLButtonElement>(null)
  // mounted marker for tests. A native effect runs BEFORE the host's refs and handlers are bound (gap G9), so the
  // marker waits one microtask: mount binds synchronously right after the effects run.
  useEffect(() => {
    queueMicrotask(() => root.current?.setAttribute('data-ready', ''))
  }, [])
  const [rows, setRows] = useState<string[]>([])
  const [turn, setTurn] = useState(0)
  return (
    <div className="probe">
      <div className="cta">
        <button
          ref={root}
          type="button"
          className="demo-btn"
          onClick={() => {
            const name = names[turn % names.length]!
            const v = Math.random().toString(36).slice(2, 8)
            const out: string[] = []
            for (const url of [`/demo/pokemon/${name}?v=${v}`, `/demo/pokemon/${name}?v=${v}`, `/demo/pokemon/${name}?v=${v}&nocache=1`]) {
              const r = demoCache.get(url)
              out.push(`${r.status} · x-brust-cache: ${r.cache} · GET ${url}`)
            }
            setRows(out)
            setTurn(turn + 1)
          }}
        >
          Request three times
        </button>
      </div>
      <ol className="sig-list" aria-live="polite">
        {rows.length === 0 ? <li className="hint">Press the button: same URL twice, then once with ?nocache=1.</li> : null}
        {rows.map((r) => (
          <li key={r}>
            <code>{r}</code>
          </li>
        ))}
      </ol>
      <p className="vp-note">
        Simulated in your browser: <code>brust start</code> sends these headers for real.
      </p>
    </div>
  )
}
