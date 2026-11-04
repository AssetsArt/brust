import { useState } from 'react'
import { Price } from './parts'
// Review 05ee17fd (b): a stateful route root; its props are the loader's and never change after the page loads.
export default function StatefulRootPage({ mode }: { mode: string }) {
  const [n, setN] = useState(0)
  return (
    <main>
      <button onClick={() => setN(n + 1)}>{n}</button>
      {mode === 'a' && <Price price={2} />}
    </main>
  )
}
