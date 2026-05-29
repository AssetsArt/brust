import { useState } from 'react'

export interface CounterProps {
  start?: number
  label?: string
}

// Shared bench island component — rendered by the React-SSR `/` probe (via
// HelloWorld) on all three scenarios, and by the brust native-island probes.
// Kept byte-identical to the example's Counter so the React-SSR comparison is
// apples-to-apples.
export default function Counter({ start = 0, label = 'count' }: CounterProps) {
  const [n, setN] = useState(start)
  return (
    <button
      data-testid="counter"
      onClick={() => setN(n + 1)}
      className="my-3 px-3 py-1.5 bg-white border border-line rounded text-sm font-mono hover:border-brand transition-colors"
    >
      {label}: {n}
    </button>
  )
}
