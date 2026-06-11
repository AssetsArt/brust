// NATIVE side of the Home unified-store demo — a single-file native
// component: `behavior` (client logic, react-free) + a JSX default the
// compiler lowers to a template. It writes the SAME `unifiedStore` the React
// island subscribes to; the directive runtime keeps `x-text` live, so a
// click here re-renders the island and the center node too. The behavior
// chunk ships zero React — that's the point of the panel's label.
import { computed } from 'brustjs/store'
import { unifiedStore } from '../lib/unified-store'

// behavior → client bundle (registered "unifiedNative" via auto x-data).
export const behavior = () => {
  const count = computed(() => String(unifiedStore.count()))
  const bump = () => unifiedStore.count.set(unifiedStore.count() + 1)
  return { count, bump }
}

// default → jinja (server). The "0" placeholder matches the store's initial
// value, so first paint and first hydration agree.
export default function UnifiedNative() {
  return (
    <div className="flex flex-col items-center gap-4">
      <p x-text="count" className="text-4xl font-bold tabular-nums">
        0
      </p>
      <button
        type="button"
        x-on-click="bump"
        className="inline-flex h-10 items-center rounded-[var(--radius-control)] border border-line px-4 text-sm font-semibold transition-colors duration-150 hover:border-fg-muted"
      >
        Increment — zero React
      </button>
    </div>
  )
}
