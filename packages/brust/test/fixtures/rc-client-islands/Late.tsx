import { useEffect, useState, useTransition } from 'react'

declare global {
  interface Window {
    __lateMounts?: number
  }
}

// A React island whose server render is null (an empty host) and whose client renders content after mount: the
// shim's empty-host path (createRoot) must mount it once and still signal data-committed.
export default function Late({ label }: { label: string }) {
  useTransition()
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    window.__lateMounts = (window.__lateMounts ?? 0) + 1
    setMounted(true)
  }, [])
  if (!mounted) return null
  return <b data-testid="late">{label}</b>
}
