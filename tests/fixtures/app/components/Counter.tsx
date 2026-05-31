// Fixture-local copy of the island Counter. The integration + native-island
// suites depend on `data-testid="counter"` and the `{label}: {n}` text; keeping
// a local copy means deleting/regenerating example/hello-world never breaks the
// test fixture (tests must be self-contained — see routes.tsx header).
import { useState } from 'react'

export interface CounterProps {
  start?: number
  label?: string
}

export default function Counter({ start = 0, label = 'count' }: CounterProps) {
  const [n, setN] = useState(start)
  return (
    <button
      type="button"
      data-testid="counter"
      onClick={() => setN(n + 1)}
      className="my-3 px-3 py-1.5 bg-white border border-line rounded text-sm font-mono hover:border-brand transition-colors"
    >
      {label}: {n}
    </button>
  )
}
