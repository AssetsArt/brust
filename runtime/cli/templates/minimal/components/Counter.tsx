import { useState } from 'react'

export default function Counter({ start = 0, label = 'count' }: { start?: number; label?: string }) {
  const [n, setN] = useState(start)
  return (
    <button
      onClick={() => setN(n + 1)}
      className="px-3 py-1.5 bg-brand text-white rounded text-sm hover:opacity-90 transition-opacity"
    >
      {label}: {n}
    </button>
  )
}
