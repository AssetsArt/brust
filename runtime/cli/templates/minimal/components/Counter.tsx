'use client'
import { useState } from 'react'

export default function Counter({ start = 0, label = 'count' }: { start?: number; label?: string }) {
  const [count, setCount] = useState(start)

  return (
    <button
      type="button"
      onClick={() => setCount((c) => c + 1)}
      className="cursor-pointer inline-flex items-center justify-center gap-3 px-6 py-3 text-sm font-semibold text-zinc-200 bg-zinc-800 border border-zinc-700 rounded-xl shadow-lg hover:bg-zinc-700 hover:border-zinc-600 focus:outline-none focus:ring-2 focus:ring-purple-500/50 active:scale-95 transition-all duration-200"
    >
      <svg
        className="w-5 h-5 text-zinc-400"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
      </svg>
      <span className="tracking-wide">{label}</span>
      <span className="ml-2 px-2.5 py-0.5 rounded-lg bg-zinc-900 text-zinc-300 border border-zinc-700/50 font-mono">
        {count}
      </span>
    </button>
  )
}
