'use client'
import { useState } from 'react'

export default function Counter({ start = 0, label = 'count' }: { start?: number; label?: string }) {
  const [count, setCount] = useState(start)
  return (
    <button
      type="button"
      onClick={() => setCount((c) => c + 1)}
      className="rounded border px-3 py-1 hover:bg-gray-50"
    >
      {label}: {count}
    </button>
  )
}
