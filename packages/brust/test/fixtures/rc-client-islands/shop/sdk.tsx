import { useState, useTransition } from 'react'

// React-only (useTransition): listed in [build] islands, so a runtime component may place it.
export function Motion({ label }: { label: string }) {
  useTransition()
  const [n, setN] = useState(0)
  return (
    <button type="button" data-testid="motion" onClick={() => setN(n + 1)}>
      {label} {n}
    </button>
  )
}

// React-only too, exposed but NOT listed: a runtime component that places it is refused.
export function Unlisted({ label }: { label: string }) {
  useTransition()
  return <i>{label}</i>
}
