// REACT ISLAND demonstrating useNav() — a top "preloader" progress bar shown
// while an SPA navigation is in flight. This is the React-island counterpart to
// NavLink's native-behavior consumption of the SAME navigation store: the native
// behavior sets a class via x-bind, this island re-renders via React. Both read
// `brustjs/navigation` through brustjs/store's cross-chunk signal tracker.
//
// Placed OUTSIDE <main> in AppLayout so the bootstrap navigator (which only
// unmounts/swaps islands inside <main>) never tears it down during the very
// navigation it is indicating. It renders nothing when idle, and an indeterminate
// bar while `phase === 'loading'`.
import { useNav } from 'brustjs/client'

export default function NavPreloader() {
  const { phase } = useNav()
  if (phase !== 'loading') return null
  return (
    <div
      className="fixed inset-x-0 top-0 z-[300] h-0.5 overflow-hidden bg-brand-500/20"
      role="progressbar"
      aria-label="Loading page"
    >
      <div className="h-full w-1/3 animate-pulse bg-brand-500" />
    </div>
  )
}
