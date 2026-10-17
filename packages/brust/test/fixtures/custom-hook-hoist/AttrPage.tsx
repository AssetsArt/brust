import { useState } from 'react'
import { useLabel } from './hooks'

function useTwice(n: number) {
  return n * 2
}

export default function AttrPage() {
  const [n, setN] = useState(0)
  return (
    <main>
      <button type="button" data-testid="attr" title={useLabel(2)} data-twice={useTwice(n)} onClick={() => setN(n + 1)}>
        {n}
      </button>
    </main>
  )
}
