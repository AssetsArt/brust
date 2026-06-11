// REACT side of the Home unified-store demo. `useStore` subscribes this
// island to the same window-singleton store the native behavior writes — a
// click on EITHER side moves both panels and the center node. CSR-only (no
// `ssr` on the Island host): the host div is empty HTML until hydration, so
// the panel slot in Home.tsx reserves the demo's height.
import { useStore } from 'brustjs/client'
import { unifiedStore } from '../lib/unified-store'

export default function UnifiedIsland() {
  const { count } = useStore(unifiedStore)
  return (
    <div className="flex flex-col items-center gap-4">
      <p className="text-4xl font-bold tabular-nums">{count}</p>
      <button
        type="button"
        onClick={() => unifiedStore.count.set(unifiedStore.count() + 1)}
        className="inline-flex h-10 items-center rounded-[var(--radius-control)] bg-accent px-4 text-sm font-semibold text-accent-fg transition-opacity duration-150 hover:opacity-90"
      >
        Increment from React
      </button>
    </div>
  )
}
