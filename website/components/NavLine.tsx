// The loading line along the top edge while a navigation loads. It reads the built-in navigation store (`state`, `to`),
// so the site never listens to the brust:nav:* events itself; Layout turns the framework's own bar off
// (data-brust-progress="off") and this is the one shown. It reads `state` only, `idle` in every page's server markup,
// so the layout renders the same on each page and is kept across navigations.
// The delay is in the loading rule only: a navigation that is quick (a cached page) leaves the line at zero, and
// idle snaps it back at once.
import { navigation } from '@brust/core/navigation'
import { useStore } from '@brust/core/store/react'

export default function NavLine() {
  const nav = useStore(navigation)
  return (
    <div
      aria-hidden="true"
      data-nav-line
      data-state={nav.state}
      data-to={nav.to ?? ''}
      className="pointer-events-none fixed inset-x-0 top-0 z-[60] h-[2px] origin-left bg-amber [transform:scaleX(0)] data-[state=loading]:[transform:scaleX(.8)] motion-safe:data-[state=loading]:[transition-property:transform] motion-safe:data-[state=loading]:[transition-duration:8s] motion-safe:data-[state=loading]:[transition-delay:.15s] motion-safe:data-[state=loading]:[transition-timing-function:cubic-bezier(.1,.8,.2,1)]"
    />
  )
}
