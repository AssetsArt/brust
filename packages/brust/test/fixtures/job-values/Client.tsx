// F585: the same value in a component the client re-renders (state): its first paint must equal the server's.
import { useState } from 'react'
import { f } from './values'

export default function Client({ x }: { x: string }) {
  const [n, setN] = useState(0)
  const v = f(x, n)
  return (
    <div>
      <p data-testid="text" title={v} hidden={v} aria-hidden={v}>{v}</p>
      {v ? <b data-testid="test">T</b> : <i data-testid="test">F</i>}
      <button type="button" data-testid="bump" onClick={() => setN(n + 1)}>{n}</button>
    </div>
  )
}
