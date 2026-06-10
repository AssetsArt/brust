import { useState } from 'react'

export default function MdCounter({ start = 0 }: { start?: number }) {
  const [n, setN] = useState(start)
  return (
    <button type="button" data-testid="md-counter" onClick={() => setN(n + 1)}>
      {n}
    </button>
  )
}
