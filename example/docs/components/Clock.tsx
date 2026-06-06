// NATIVE INTERACTIVE COMPONENT — the canonical `behavior` + ctx example for the
// Native interactivity page. Dogfoods the React-style ctx `effect()` / `onCleanup()`:
// a reactive effect starts an interval that writes the time signal, and registers
// cleanup so it's torn down on unmount / SPA-nav. react-free; ships as its own
// on-demand `clock_<hash>.directive.js` chunk. `x-data` is auto-injected.
import { signal } from 'brustjs/store'
import type { BehaviorCtx } from 'brustjs/native'

const fmt = () => new Date().toLocaleTimeString()

export const behavior = ({ effect, onCleanup }: BehaviorCtx) => {
  const label = signal(fmt())
  effect(() => {
    const id = setInterval(() => label.set(fmt()), 1000)
    onCleanup(() => clearInterval(id))
  })
  return { label }
}

// Source shown in the <Example> "Source" pane. Co-located here (a file that
// genuinely exports a behavior) so the directive text-scan never false-positives
// on a doc page (gap G5). Tree-shaken from the chunk (entry imports only behavior).
export const source =
  "import { signal } from 'brustjs/store'\nimport type { BehaviorCtx } from 'brustjs/native'\n\nexport const behavior = ({ effect, onCleanup }: BehaviorCtx) => {\n  const label = signal(new Date().toLocaleTimeString())\n\n  // runs after mount; re-runs when its reactive reads change\n  effect(() => {\n    const id = setInterval(\n      () => label.set(new Date().toLocaleTimeString()),\n      1000,\n    )\n    // cleanup on unmount (like useEffect's return)\n    onCleanup(() => clearInterval(id))\n  })\n\n  return { label }\n}"

export default function Clock() {
  return (
    <div className="flex flex-col items-center gap-2">
      <time
        x-text="label"
        className="font-mono text-3xl font-bold tabular-nums text-brand-600 dark:text-brand-400"
      >
        00:00:00
      </time>
      <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400">
        0 kb React · ctx.effect + ctx.onCleanup
      </span>
    </div>
  )
}
