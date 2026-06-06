// NATIVE INTERACTIVE COMPONENT — the canonical "playable" demo: a react-free
// counter. Single-file: `export const behavior` (client logic → its own on-demand
// `.directive.js` chunk, registered as "counter") + a JSX default the native
// compiler lowers to minijinja. `x-data` is auto-injected (it has a behavior).
//
// NOTE: every `className` is a STRING LITERAL — the native compiler resolves a
// `className={ident}` as a jinja member-path (loader context), not a JS const, so
// a shared class const would render empty. Literals only.
import { signal } from 'brustjs/store'

export const behavior = () => {
  const count = signal(0)
  const inc = () => count.set(count() + 1)
  const dec = () => count.set(count() - 1)
  const reset = () => count.set(0)
  return { count, inc, dec, reset }
}

// The source shown in the <Example> "Source" pane. It lives HERE (a file that
// legitimately exports a behavior) — NOT inline in a page — because the directive
// discovery is a text regex for `export const behavior` and would false-positive on
// a page whose code-sample string contains that phrase (framework gap G5). This
// const is tree-shaken out of the directive chunk (the entry imports only behavior).
export const source =
  'import { signal } from \'brustjs/store\'\n\nexport const behavior = () => {\n  const count = signal(0)\n  const inc = () => count.set(count() + 1)\n  const dec = () => count.set(count() - 1)\n  const reset = () => count.set(0)\n  return { count, inc, dec, reset }\n}\n\n// JSX default → native template\n// <button x-on-click="inc">+</button>\n// <span x-text="count">0</span>'

export default function Counter() {
  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        x-on-click="dec"
        aria-label="decrement"
        className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-300 text-lg font-semibold text-slate-700 transition-colors hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
      >
        −
      </button>
      <span
        x-text="count"
        className="min-w-12 rounded-lg bg-brand-500/10 px-3 py-1.5 text-center text-lg font-bold tabular-nums text-brand-600 dark:text-brand-400"
      >
        0
      </span>
      <button
        type="button"
        x-on-click="inc"
        aria-label="increment"
        className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-300 text-lg font-semibold text-slate-700 transition-colors hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
      >
        +
      </button>
      <button
        type="button"
        x-on-click="reset"
        className="ml-1 rounded-lg px-3 py-1.5 text-sm font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
      >
        Reset
      </button>
    </div>
  )
}
