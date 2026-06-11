// DemoCounter — a deliberately tiny React island, embedded LIVE in
// content/markdown-pages.md as `<DemoCounter start={3} />`. It exists to prove
// the md component-tag pipeline end to end: server-rendered HTML in the host
// div, the island chunk hydrating on load, literal `{42}` props crossing the
// md → island boundary. Styled with the app.css token utilities (bg-surface,
// border-line, …) so it follows the theme like everything else.
import { useState } from 'react'

export default function DemoCounter({ start = 0 }: { start?: number }) {
  const [count, setCount] = useState(start)
  return (
    <div className="my-2 inline-flex items-center gap-3 rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3">
      <button
        type="button"
        onClick={() => setCount((c) => c + 1)}
        className="rounded-[var(--radius-control)] bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg transition-opacity hover:opacity-90"
      >
        Increment
      </button>
      <span className="text-sm text-fg-muted">
        count = <span className="font-semibold text-fg">{count}</span>
      </span>
    </div>
  )
}
