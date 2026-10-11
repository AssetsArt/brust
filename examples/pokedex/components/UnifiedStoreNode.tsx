// components/UnifiedStoreNode.tsx — the centre node: a read-only native view of the same store both panels write (0 jobs).
import { useStore } from '@brust/core/store/react'
import { unified } from '../stores/unified'

export default function UnifiedStoreNode() {
  const { count } = useStore(unified)
  return (
    <div className="flex min-w-36 flex-col items-center gap-1 rounded-2xl border-2 border-brand-500 px-6 py-5 text-center">
      <span className="text-sm font-semibold">one store</span>
      <span data-testid="unified-node-count" className="text-3xl font-bold tabular-nums text-brand-500">{count}</span>
      <code className="text-sm text-slate-500 dark:text-slate-400">unified</code>
    </div>
  )
}
