import { useState } from 'react'
import { Outer } from './RestHlp'

// the caller's rest is LIVE: a clone cannot re-spread it on the client, so the call must not stay native
export default function P() {
  const [n, setN] = useState(0)
  return (
    <main>
      <button onClick={() => setN(n + 1)}>inc</button>
      <Outer data-n={n} />
    </main>
  )
}
