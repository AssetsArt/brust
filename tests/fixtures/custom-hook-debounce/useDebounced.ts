import { useEffect, useState } from 'react'

// The custom hook the case imports: brust inlines it at the call site (G3).
export function useDebounced(value: string, ms: number) {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return settled
}
