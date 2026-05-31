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
      onClick={() => setN(n + 1)}
      className="my-3 px-3 py-1.5 bg-white border border-line rounded text-sm font-mono hover:border-brand transition-colors"
    >
      {label}: {n}
    </button>
  )
}
