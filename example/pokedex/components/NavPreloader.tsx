// REACT ISLAND demonstrating useNav() — a top "preloader" progress bar shown
// while an SPA navigation is in flight. This is the React-island counterpart to
// NavLink's native-behavior consumption of the SAME navigation store: the native
// behavior sets a class via x-bind, this island re-renders via React. Both read
// `brustjs/navigation` through brustjs/store's cross-chunk signal tracker.
//
// Placed OUTSIDE <main> in AppLayout so the bootstrap navigator (which only
// unmounts/​swaps islands inside <main>) never tears it down during the very
// navigation it is indicating. It renders nothing when idle, and an indeterminate
// bar while `phase === 'loading'`.
import { useNav } from 'brustjs/client'

export default function NavPreloader() {
  const { phase } = useNav()
  if (phase !== 'loading') return null
  return (
    <div className="nav-preloader" role="progressbar" aria-label="กำลังโหลดหน้า">
      <div className="nav-preloader__bar" />
    </div>
  )
}
