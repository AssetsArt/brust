// components/UnifiedNative.tsx — NATIVE (0 jobs): render reads the `unified` store, the handler writes it. The chunk ships zero React.
import { useStore } from '@brust/core/store/react'
import { unified } from '../stores/unified'

export default function UnifiedNative() {
  const s = useStore(unified)
  return (
    <div className="flex flex-col items-center gap-4">
      <p data-testid="unified-native-count" className="text-4xl font-bold tabular-nums">{s.count}</p>
      <button
        type="button"
        data-testid="unified-native-inc"
        onClick={() => unified.count.set(s.count + 1)}
        className="inline-flex h-10 items-center rounded-lg border border-slate-300 px-4 text-sm font-semibold transition-colors hover:border-slate-500 dark:border-slate-600"
      >
        Increment — zero React
      </button>
    </div>
  )
}
