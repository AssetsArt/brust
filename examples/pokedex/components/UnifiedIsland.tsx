// components/UnifiedIsland.tsx — React island (SSR + hydration). `useStore` alone compiles native, so the "clicks from
// React" tally (useReducer) is what puts this on the react tier (D10 asks for an island).
import { useStore } from '@brust/core/store/react'
import { useReducer, useTransition } from 'react'
import { unified } from '../stores/unified'

const tick = (n: number): number => n + 1

export default function UnifiedIsland() {
  const { count } = useStore(unified)
  useTransition()
  const [mine, tally] = useReducer(tick, 0)
  return (
    <div className="flex flex-col items-center gap-4">
      <p data-testid="unified-island-count" className="text-4xl font-bold tabular-nums">{count}</p>
      <button
        type="button"
        data-testid="unified-island-inc"
        onClick={() => {
          tally()
          unified.count.set(count + 1)
        }}
        className="inline-flex h-10 items-center rounded-lg bg-brand-500 px-4 text-sm font-semibold text-white transition-opacity hover:opacity-90"
      >
        Increment from React ({mine})
      </button>
    </div>
  )
}
