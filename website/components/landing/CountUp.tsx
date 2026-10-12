// A benchmark number: the server renders the final value; when it scrolls into view it counts up from 0 (native; no animation under reduced motion).
import { useEffect, useRef, useState } from 'react'

export default function CountUp({ end, text, decimals }: { end: number; text: string; decimals: number }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [shown, setShown] = useState(text)
  useEffect(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) return
    const seen = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return
        seen.disconnect()
        const t0 = performance.now()
        const id = setInterval(() => {
          const p = Math.min(1, (performance.now() - t0) / 1000)
          const v = end * (1 - Math.pow(1 - p, 3))
          setShown(v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }))
          if (p >= 1) {
            clearInterval(id)
            setShown(text)
          }
        }, 32)
      },
      { threshold: 0.6 },
    )
    if (ref.current) seen.observe(ref.current)
    return () => seen.disconnect()
  }, [end, text, decimals])
  return <span ref={ref}>{shown}</span>
}
