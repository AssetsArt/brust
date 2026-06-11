// REACT ISLAND — top progress bar shown while an SPA navigation is in flight
// (same pattern as example/pokedex/components/NavPreloader.tsx). useNav() reads
// the brustjs/navigation store the bootstrap navigator drives; the bar renders
// only during `phase === 'loading'` and nothing when idle.
//
// Mounted in DocsLayout OUTSIDE <main>: the navigator only unmounts/swaps
// islands inside <main>, so the island survives the very navigation it is
// indicating. z/animation: --z-preloader from the app.css scale; the global
// prefers-reduced-motion rule flattens animate-pulse to a static bar.
import { useNav } from 'brustjs/client'

export default function NavPreloader() {
  const { phase } = useNav()
  if (phase !== 'loading') return null
  return (
    <div
      className="fixed inset-x-0 top-0 z-[var(--z-preloader)] h-0.5 overflow-hidden bg-brand-500/20"
      role="progressbar"
      aria-label="Loading page"
    >
      <div className="h-full w-1/3 animate-pulse bg-brand-300" />
    </div>
  )
}
