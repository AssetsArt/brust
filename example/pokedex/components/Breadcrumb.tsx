// NATIVE INTERACTIVE COMPONENT — the breadcrumb leaf. It lives in AppLayout's
// persistent shell (OUTSIDE <main>), so the SSR-baked `crumb` would go stale on
// SPA navigation (only <main>/<Outlet> swaps; the shell does not re-render). Like
// NavLink, the fix is to WATCH the navigation store: a `computed` over `nav.path()`
// re-derives the label on every SPA nav, so the breadcrumb updates without a reload.
//
// Single-file component: `export const behavior` → _directives.js (react-free);
// the JSX default → the native template the compiler lowers to minijinja. The SSR
// text is the loader's `crumb` (correct for the first paint); the behavior takes
// over on hydration and on each navigation.
import { nav } from 'brustjs/navigation'
import { computed } from 'brustjs/store'

const STATIC_LABELS: Record<string, string> = {
  '/': 'Home',
  '/pokedex': 'Pokédex',
  '/type-chart': 'Type chart',
}

// Capitalize + de-dash a path segment (mirrors pokeapi `cap`, inlined to keep the
// directive chunk free of the loader/fetch module).
const cap = (s: string): string =>
  s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/-/g, ' ') : s

/** Derive the crumb label from the current path — the detail route carries the
 *  Pokémon name in the path itself (`/pokemon/ivysaur` → "Ivysaur"), so no loader
 *  data is needed client-side. */
function deriveCrumb(path: string): string {
  if (STATIC_LABELS[path]) return STATIC_LABELS[path] as string
  const seg = path.split('/').filter(Boolean)
  if (seg[0] === 'pokemon' && seg[1]) return cap(seg[1])
  return cap(seg[seg.length - 1] ?? '') || 'Home'
}

// behavior → registered as "breadcrumb". Watches nav.path; x-text binds `label`.
export const behavior = () => {
  const label = computed(() => deriveCrumb(nav.path()))
  return { label }
}

// default → jinja. SSR renders the loader `crumb`; `x-text="label"` overrides it on
// bind and on every SPA navigation.
export default function Breadcrumb({ crumb }: { crumb: string }) {
  return (
    <b x-text="label" className="text-slate-600 dark:text-slate-300">
      {crumb}
    </b>
  )
}
