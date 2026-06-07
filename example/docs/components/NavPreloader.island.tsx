// REACT ISLAND — a top progress bar shown while an SPA navigation is in flight.
// Reads the SAME navigation store the native sidebar reconciler consumes
// (brustjs/navigation, via brustjs/store's cross-chunk signal tracker): useNav()
// re-renders this island when `phase` flips to 'loading' and back.
//
// Placed OUTSIDE <main> in Layout so the bootstrap navigator (which only swaps
// islands inside <main>) never tears it down during the very navigation it is
// indicating. Renders nothing when idle; an indeterminate bar while loading.
import { useNav } from 'brustjs/client'

export default function NavPreloader() {
  const { phase } = useNav()
  if (phase !== 'loading') return null
  return (
    <div className="b-navloader" role="progressbar" aria-label="Loading page">
      <div className="b-navloader__bar" />
    </div>
  )
}
