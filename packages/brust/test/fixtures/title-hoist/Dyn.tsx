import { useState } from 'react'

// A page whose title and description follow client state: brust binds them where they are (it does not hoist what it
// binds), so they keep updating.
export default function Dyn() {
  const [n, setN] = useState(0)
  const open = n % 2 === 1
  return (
    <main>
      <title>{`Count ${n}`}</title>
      {open ? <meta name="description" content="open" /> : <meta name="description" content="closed" />}
      <button type="button" data-testid="go" onClick={() => setN(n + 1)}>
        +
      </button>
    </main>
  )
}
