import { useState } from 'react'

// An interactive component whose root is a fragment keeps <brust-host> (and warns at build time).
export default function Pair() {
  const [n, setN] = useState(0)
  return (
    <>
      <dt data-testid="n">{n}</dt>
      <dd>
        <button onClick={() => setN(n + 1)}>+</button>
      </dd>
    </>
  )
}
