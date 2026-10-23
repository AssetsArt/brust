import { useState } from 'react'

// The filed B-6 repro: a list mapped inside a list row, the outer row hidden by state.
const TABS = [
  { id: 'a', lines: ['one', 'two'] },
  { id: 'b', lines: ['three'] },
]
export default function PRepro() {
  const [i, setI] = useState(0)
  return (
    <main>
      <button type="button" data-testid="go" onClick={() => setI(1)}>
        b
      </button>
      {TABS.map((t, k) => (
        <pre key={t.id} hidden={i !== k}>
          {t.lines.map((l) => (
            <div key={l}>{l}</div>
          ))}
        </pre>
      ))}
    </main>
  )
}
