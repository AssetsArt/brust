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
  return <span className="absolute top-[.4rem] bottom-[.4rem] left-[1.05rem] w-[2px] origin-top bg-amber [transform:scaleY(var(--rail,0))] motion-safe:[transition:transform_.1s_linear]" aria-hidden="true" />
}
