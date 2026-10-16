import { useState } from 'react'
import Thumb from './Thumb'
// Mellow F1: a native child that hands its rest to a static child it does not link (Thumb prints `on` once).
export default function Mid5({ x, ...rest }: any) {
  const [n, setN] = useState(0)
  return (
    <div data-testid="box" data-n={n} data-x={x} onClick={() => setN(n + 1)}>
      <span>m</span>
      <Thumb {...rest} />
    </div>
  )
}
