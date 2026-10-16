import { useEffect, useState } from 'react'
import { useIsHydrated } from './rhydr'

// the hydration flag read in the render and in an effect (as Radix's roving group does)
export default function HydrBox() {
  const hydrated = useIsHydrated()
  const [n, setN] = useState(0)
  const [seen, setSeen] = useState('none')
  useEffect(() => {
    if (!hydrated) return
    setSeen('effect')
  }, [hydrated])
  return (
    <button type="button" data-h={hydrated ? 'y' : 'n'} data-seen={seen} onClick={() => setN(n + 1)}>
      {n}
    </button>
  )
}
