// Loads LazyPanel's module after mount; the stylesheet it imports is already linked on first paint.
import { useEffect, useState } from 'react'

export default function LazyPage() {
  const [loaded, setLoaded] = useState('no')
  useEffect(() => {
    import('./LazyPanel').then(() => setLoaded('yes'))
  }, [])
  return (
    <p id="lazy-target" data-loaded={loaded}>
      lazy
    </p>
  )
}
