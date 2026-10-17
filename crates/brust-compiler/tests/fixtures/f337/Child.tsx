import { useState } from 'react'
// F337: children with values derived from a prop through module helpers (multi-statement: placed as job slots).
function pct(n: number) {
  if (n > 100) return 'over'
  return Math.round(n) + '%'
}
function local(n: number) {
  if (n > 100) return 'over'
  return n.toLocaleString()
}
export function Simple({ v }: { v: number }) {
  const [o, setO] = useState(false)
  const text = pct(v)
  return (
    <b data-t={text} data-o={o ? 1 : 0} onClick={() => setO(!o)}>
      x
    </b>
  )
}
export function HostDep({ v }: { v: number }) {
  const [o, setO] = useState(false)
  const text = local(v)
  return (
    <b data-t={text} data-o={o ? 1 : 0} onClick={() => setO(!o)}>
      x
    </b>
  )
}
