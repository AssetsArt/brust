// HERO copy-able create command (the scaffold one-liner under the CTAs).
// A native single-file component: the behavior writes the command to the
// clipboard and flips a short-lived "Copied" hint; the default JSX is a
// static template the compiler lowers — no React in the chunk.
//
// Clipboard needs a secure context (localhost/https). Anywhere else
// `navigator.clipboard` is undefined and the click is a silent no-op —
// the command text itself is still selectable.
import { computed, signal } from 'brustjs/store'

const COMMAND = 'bun create brustjs my-app'

// behavior → client bundle (registered "copyCommand" via auto x-data).
export const behavior = () => {
  const copied = signal(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  const hint = computed(() => (copied() ? 'Copied' : 'Copy'))

  function copy() {
    try {
      navigator.clipboard
        ?.writeText(COMMAND)
        .then(() => {
          copied.set(true)
          clearTimeout(timer)
          timer = setTimeout(() => copied.set(false), 1200)
        })
        .catch(() => {
          // clipboard rejected (permissions) — silent no-op
        })
    } catch {
      // clipboard unavailable (insecure context) — silent no-op
    }
  }

  return { hint, copy }
}

// default → jinja (server). Explicit light-on-dark colors: this sits in the
// hero, which is dark in BOTH themes. "Copy" placeholder matches the
// behavior's initial computed value so first paint and hydration agree.
export default function CopyCommand() {
  return (
    <button
      type="button"
      x-on-click="copy"
      className="inline-flex h-11 items-center gap-3 rounded-[var(--radius-control)] border border-white/20 bg-white/5 px-4 font-mono text-sm text-white/90 transition-colors duration-150 hover:border-white/45"
    >
      <span aria-hidden="true" className="select-none text-white/50">
        $
      </span>
      <span>bun create brustjs my-app</span>
      <span
        x-text="hint"
        aria-live="polite"
        className="ml-1 min-w-12 text-left font-sans text-sm font-medium text-brand-300"
      >
        Copy
      </span>
    </button>
  )
}
