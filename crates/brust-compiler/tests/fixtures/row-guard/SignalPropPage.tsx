import { useState } from 'react'
import { Price } from './parts'
// F504a: a component whose props are a signal (it has state): a condition over a prop is one the client may flip.
export default function SignalPropPage({ mode, p }: { mode: string; p: number }) {
  const [n, setN] = useState(0)
  return (
    <main>
      <button onClick={() => setN(n + 1)}>{n}</button>
      {mode === 'a' && <Price price={2} />}
    </main>
  )
}
