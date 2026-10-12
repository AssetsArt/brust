// Demo, native tier: fetches the cached demo route and shows the REAL x-brust-cache header of each response.
// A fresh query string makes a fresh L1 key, so the first request is a MISS and the second a HIT; ?nocache=1 hits the
// route's bypass expression.
import { useState } from 'react'

export default function CacheProbe({ names }: { names: string[] }) {
  const [rows, setRows] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [turn, setTurn] = useState(0)
  return (
    <div className="probe">
      <div className="cta">
        <button
          type="button"
          className="demo-btn"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            const name = names[turn % names.length]!
            const v = Math.random().toString(36).slice(2, 8)
            const out: string[] = []
            for (const url of [`/demo/pokemon/${name}?v=${v}`, `/demo/pokemon/${name}?v=${v}`, `/demo/pokemon/${name}?v=${v}&nocache=1`]) {
              const t0 = performance.now()
              const r = await fetch(url)
              await r.text()
              out.push(`${r.status} · x-brust-cache: ${r.headers.get('x-brust-cache') ?? '(none)'} · ${(performance.now() - t0).toFixed(1)} ms · GET ${url}`)
            }
            setRows(out)
            setTurn(turn + 1)
            setBusy(false)
          }}
        >
          Fetch three times
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
    </div>
  )
}
