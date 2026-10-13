// The step rail's fill (native): grows with the scroll position through the steps (transform via a CSS variable; none under reduced motion).
import { useEffect } from 'react'

export default function RailFill() {
  useEffect(() => {
    const rail = document.getElementById('rail')
    if (!rail) return
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
    const update = () => {
      const r = rail.getBoundingClientRect()
      const p = Math.max(0, Math.min(1, (innerHeight * 0.6 - r.top) / r.height))
      document.documentElement.style.setProperty('--rail', reduce ? '0' : p.toFixed(3))
    }
    update()
    addEventListener('scroll', update, { passive: true })
    return () => removeEventListener('scroll', update)
  }, [])
  return <span className="rail-fill" aria-hidden="true" />
}
