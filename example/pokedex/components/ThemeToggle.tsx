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
import { client } from 'brustjs/client'
import { computed, signal } from 'brustjs/store'
import type { Actions } from '../actions'

const api = client<Actions>()

// behavior → client bundle, registered as "themeToggle". Reads the initial mode
// straight off <html data-mode> (server already set it from the cookie).
export const behavior = () => {
  const mode = signal(
    typeof document !== 'undefined' ? (document.documentElement.dataset.mode ?? 'dark') : 'dark',
  )
  const label = computed(() => (mode() === 'dark' ? '☀ Light' : '🌙 Dark'))

  async function toggle() {
    const next = mode() === 'dark' ? 'light' : 'dark'
    document.documentElement.dataset.mode = next // flip the theme immediately
    mode.set(next)
    await api.theme.post({ mode: next }) // persist via cookie for the next SSR
  }

  return { toggle, label }
}

// default → jinja (server). The x-* directives are static string attributes the
// native compiler passes straight through; the directive runtime binds them to
// the behavior instance on the client.
export default function ThemeToggle() {
  return (
    <button
      type="button"
      x-data="themeToggle"
      x-text="label"
      x-on-click="toggle"
      className="inline-flex items-center rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
    >
      🌙 Dark
    </button>
  )
}
