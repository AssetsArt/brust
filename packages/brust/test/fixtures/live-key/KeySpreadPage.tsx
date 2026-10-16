import { useState } from 'react'

function Counter() {
  const [n, setN] = useState(0)
  return <button type="button" data-testid="count" onClick={() => setN(n + 1)}>{n}</button>
}

// F334 (F308 through a spread): React remounts <Counter> when its key changes (the count resets); brust keeps the instance, so the page is a named
// refusal and renders with React.
export default function KeySpreadPage() {
  const [k, setK] = useState(0)
  return (
    <main>
      <Counter {...{ key: k }} />
      <button type="button" data-testid="swap" onClick={() => setK(k + 1)}>swap</button>
    </main>
  )
}
