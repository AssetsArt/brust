// DemoBadge — a native behavior component embedded LIVE in
// content/markdown-pages.md as `<DemoBadge />`. The default export compiles to
// a FULLY STATIC inlined host (the md behavior contract: every rendered value
// is a literal — here there are none) and the `behavior` ships as a react-free
// directive chunk; `x-on-click`/`x-text` wire the click counter with zero
// React on the client.
import { computed, signal } from 'brustjs/store'

// → client chunk (react-free)
export const behavior = () => {
  const count = signal(0)
  const label = computed(() => (count() === 1 ? '1 click' : `${count()} clicks`))
  function increment() {
    count.set(count() + 1)
  }
  return { increment, label }
}

// → server template (static — inlined into the md page's jinja at build time)
export default function DemoBadge() {
  return (
    <button
      type="button"
      x-on-click="increment"
      className="my-2 inline-flex items-center gap-2 rounded-full border border-line bg-surface px-4 py-2 text-sm transition-colors hover:border-fg-muted"
    >
      <span className="font-semibold text-fg">DemoBadge</span>
      <span x-text="label" className="text-fg-muted">
        0 clicks
      </span>
    </button>
  )
}
