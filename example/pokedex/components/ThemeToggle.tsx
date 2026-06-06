// NATIVE INTERACTIVE COMPONENT — the dark/light theme toggle in the navbar.
// Single-file native directive component: a co-located `export const behavior`
// (client logic, react-free) + a JSX `default` export (the native template the
// compiler lowers to minijinja). The build bundles ONLY `behavior` into
// _directives.js, registered as "themeToggle" (camelCase filename); the JSX
// default is tree-shaken out so react never leaks client-side.
//
// react-free: `signal`/`computed` from brustjs/store (the window singleton on
// the client), `client` from brustjs/client (the treaty action client). The
// toggle flips <html data-mode> immediately (no reload) AND persists via the
// /theme action which sets the `mode` cookie — so SSR matches on the next load.
import { Moon, Sun } from 'lucide-react'
import { client } from 'brustjs/client'
import type { BehaviorCtx } from 'brustjs/native'
import { computed, signal } from 'brustjs/store'
import type { Actions } from '../actions'

const api = client<Actions>()

// behavior → client bundle, registered as "themeToggle". Reads the initial mode
// straight off <html data-mode> (server already set it from the cookie).
export const behavior = ({ effect }: BehaviorCtx) => {
  const mode = signal(
    typeof document !== 'undefined' ? (document.documentElement.dataset.mode ?? 'dark') : 'dark',
  )
  const label = computed(() => (mode() === 'dark' ? 'Light' : 'Dark'))
  // x-text can't host an SSR icon (it replaces textContent), so the sun/moon
  // icons live in sibling spans toggled by x-show on these mode computeds.
  const isDark = computed(() => mode() === 'dark')
  const isLight = computed(() => mode() === 'light')

  // Reactive sync (dogfooding ctx `effect`): reflect `mode` onto <html data-mode>
  // whenever it changes — the toggle just flips the signal, the DOM follows. On
  // mount this runs once and writes the value the server already set (a no-op, so
  // no flash). Replaces the imperative `dataset.mode = …` that lived in toggle().
  effect(() => {
    document.documentElement.dataset.mode = mode()
  })

  async function toggle() {
    const next = mode() === 'dark' ? 'light' : 'dark'
    mode.set(next) // the effect flips <html data-mode> reactively
    await api.theme.post({ mode: next }) // persist via cookie for the next SSR
  }

  return { toggle, label, isDark, isLight }
}

// default → jinja (server). The x-* directives are static string attributes the
// native compiler passes straight through; the directive runtime binds them to
// the behavior instance on the client. `themeLabel` is server-stamped (the
// inverse of the active mode) so the x-text placeholder already shows the right
// word — no Dark→Light flash before the behavior hydrates.
export default function ThemeToggle({ themeLabel }: { themeLabel: string }) {
  return (
    <button
      type="button"
      x-on-click="toggle"
      aria-label="Toggle theme"
      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
    >
      <span x-show="isDark" className="theme-icon-dark inline-flex">
        <Sun size={16} />
      </span>
      <span x-show="isLight" className="theme-icon-light inline-flex">
        <Moon size={16} />
      </span>
      <span x-text="label">{themeLabel}</span>
    </button>
  )
}
