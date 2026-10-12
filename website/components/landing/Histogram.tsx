// A latency histogram: the bars are in the server HTML at full height; one that starts below the fold is armed (collapsed) and grows when it scrolls into view.
import { useEffect, useRef, useState } from 'react'
import type { Bar } from '../../lib/bench'

export default function Histogram({ bars }: { bars: Bar[] }) {
  const ref = useRef<HTMLDivElement>(null)
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) return
    if (el.getBoundingClientRect().top <= innerHeight) return
    setArmed(true)
    const seen = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setArmed(false)
          seen.disconnect()
        }
      },
      { threshold: 0.5 },
    )
    seen.observe(el)
    return () => seen.disconnect()
  }, [])
  return (
    <div ref={ref} className={armed ? 'hg armed' : 'hg'} aria-label="Latency distribution">
      {bars.map((b) => (
        <i key={b.title} style={{ '--h': b.h, '--d': b.d }} title={b.title} />
      ))}
    </div>
  )
}
