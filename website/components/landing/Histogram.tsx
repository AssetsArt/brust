// A latency histogram: the bars are in the server HTML at full height; one that starts below the fold is armed (collapsed) and grows when it scrolls into view.
import { useEffect, useRef, useState } from 'react'
import type { Bar } from '../../lib/bench'

export default function Histogram({ bars, lead }: { bars: Bar[]; lead: boolean }) {
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
    <div ref={ref} className={armed ? 'group/hg armed mt-5 grid h-[56px] auto-cols-[1fr] grid-flow-col items-end gap-[3px] border-b border-term-rule' : 'group/hg mt-5 grid h-[56px] auto-cols-[1fr] grid-flow-col items-end gap-[3px] border-b border-term-rule'} aria-label="Latency distribution">
      {bars.map((b) => (
        <i key={b.title} style={{ '--h': b.h, '--d': b.d }} className={lead ? 'block h-[var(--h)] origin-bottom rounded-t-xs group-[.armed]/hg:[transform:scaleY(0)] motion-safe:[transition:transform_.8s_var(--ease)_var(--d,0s)] bg-amber opacity-90' : 'block h-[var(--h)] origin-bottom rounded-t-xs group-[.armed]/hg:[transform:scaleY(0)] motion-safe:[transition:transform_.8s_var(--ease)_var(--d,0s)] bg-term-dim opacity-75'} title={b.title} />
      ))}
    </div>
  )
}
