// CENTER node of the Home unified-store demo — the "unified memory" itself.
// A read-only native behavior subscribed to the same store both panels write;
// its live value is the visual proof that there is exactly one substrate.
import { computed } from 'brustjs/store'
import { unifiedStore } from '../lib/unified-store'

// behavior → client bundle (registered "unifiedStoreNode" via auto x-data).
export const behavior = () => {
  const count = computed(() => String(unifiedStore.count()))
  return { count }
}

// default → jinja (server). `.unified-node` (app.css) carries the tinted
// border treatment; the "0" placeholder matches the store's initial value.
export default function UnifiedStoreNode() {
  return (
    <div className="unified-node flex min-w-36 flex-col items-center gap-1 px-6 py-5 text-center">
      <span className="text-sm font-semibold">one store</span>
      <span x-text="count" className="text-3xl font-bold tabular-nums text-link">
        0
      </span>
      <code className="text-sm text-fg-muted">docs.unified</code>
    </div>
  )
}
