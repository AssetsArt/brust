import { useState } from 'react'

export interface CounterProps {
  start?: number
  label?: string
}

export default function Counter({ start = 0, label = 'count' }: CounterProps) {
  const [n, setN] = useState(start)
  return (
    <button data-testid="counter" onClick={() => setN(n + 1)}>
      {label}: {n}
    </button>
  )
}
