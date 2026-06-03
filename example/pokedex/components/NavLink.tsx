// NATIVE INTERACTIVE COMPONENT — a sidebar nav link whose active state is driven
// by the navigation store, WATCHED in the behavior and applied by the author (no
// data-brust-active-nav magic attribute). This is the "consume the nav store
// yourself" pattern: `nav` from brustjs/navigation is a plain reactive source
// (signals shared cross-chunk via brustjs/store's Symbol.for tracker), so a
// `computed` over `nav.path()` re-runs on every SPA navigation — the same store
// the React island reads via useNav(). The bootstrap-owned navigator commits
// nav.path; this behavior reacts.
//
// Single-file component: `export const behavior` → _directives.js (react-free);
// the JSX default → the native template the compiler lowers to minijinja.
import { nav } from 'brustjs/navigation'
import { computed } from 'brustjs/store'

// behavior → registered as "navLink". Reads the link's own href off the element
// (no x-props needed), watches nav.path, and returns the active className +
// aria-current. x-bind-class sets the full className; x-bind-aria-current with a
// null value removes the attribute (see runtime setBound).
export const behavior = ({ el }: { el: HTMLElement }) => {
  const linkPath = new URL((el as HTMLAnchorElement).href, location.href).pathname
  const cls = computed(() => (nav.path() === linkPath ? 'aa-nav-item is-active' : 'aa-nav-item'))
  const current = computed(() => (nav.path() === linkPath ? 'page' : null))
  return { cls, current }
}

// default → jinja. The SSR className is the inactive base; the behavior sets
// is-active on bind and on every SPA nav. `count` is an optional native inline
// conditional (the "native" chip on the type-chart link).
export default function NavLink({
  href,
  label,
  count,
}: {
  href: string
  label: string
  count?: string
}) {
  return (
    <a
      x-data="navLink"
      x-bind-class="cls"
      x-bind-aria-current="current"
      className="aa-nav-item"
      href={href}
    >
      <span>{label}</span>
      {count ? <span className="aa-nav-item__count">{count}</span> : null}
    </a>
  )
}
