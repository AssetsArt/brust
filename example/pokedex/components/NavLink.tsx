// NATIVE INTERACTIVE COMPONENT — a navbar link whose active state is driven by
// the navigation store, WATCHED in the behavior and applied by the author. `nav`
// from brustjs/navigation is a plain reactive source (signals shared cross-chunk
// via brustjs/store's Symbol.for tracker), so a `computed` over `nav.path()`
// re-runs on every SPA navigation — the same store the React island reads via
// useNav(). The bootstrap-owned navigator commits nav.path; this behavior reacts.
//
// Single-file component: `export const behavior` → _directives.js (react-free);
// the JSX default → the native template the compiler lowers to minijinja.
import { nav } from 'brustjs/navigation'
import { computed } from 'brustjs/store'

const BASE =
  'inline-flex items-center rounded-lg px-3 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white'
const ACTIVE =
  'inline-flex items-center rounded-lg px-3 py-1.5 text-sm font-semibold text-brand-600 bg-brand-50 transition-colors dark:text-brand-50 dark:bg-brand-600/20'

// behavior → registered as "navLink". Reads the link's own href off the element
// (no x-props needed), watches nav.path, and returns the active className +
// aria-current. x-bind-class sets the full className; x-bind-aria-current with a
// null value removes the attribute (see runtime setBound).
export const behavior = ({ el }: { el: HTMLElement }) => {
  const linkPath = new URL((el as HTMLAnchorElement).href, location.href).pathname
  const cls = computed(() => (nav.path() === linkPath ? ACTIVE : BASE))
  const current = computed(() => (nav.path() === linkPath ? 'page' : null))
  return { cls, current }
}

// default → jinja. The SSR className is the inactive base; the behavior sets the
// active class on bind and on every SPA nav.
export default function NavLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      x-data="navLink"
      x-bind-class="cls"
      x-bind-aria-current="current"
      className="inline-flex items-center rounded-lg px-3 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white"
      href={href}
    >
      <span>{label}</span>
    </a>
  )
}
