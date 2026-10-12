import { useEffect, useRef, useState } from 'react'

// F97: the CountUp shape — a mount effect arms an IntersectionObserver on a ref. The effect used to run
// before x-ref was bound (ref.current === null), so it silently did nothing.
export default function CountUp() {
  const ref = useRef<HTMLSpanElement>(null)
  const [shown, setShown] = useState('100')
  useEffect(() => {
    if (!('IntersectionObserver' in window)) return
    const seen = new IntersectionObserver((entries) => {
      if (!entries[0]?.isIntersecting) return
      seen.disconnect()
      setShown('42')
    })
    if (ref.current) seen.observe(ref.current)
    return () => seen.disconnect()
  }, [])
  return <span id="v" ref={ref}>{shown}</span>
}
