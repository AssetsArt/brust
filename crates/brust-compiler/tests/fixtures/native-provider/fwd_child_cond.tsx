import { useRef, useState } from 'react'
import { Fc } from './Fwd'

export default function P() {
  const r = useRef<HTMLButtonElement>(null)
  const [n, setN] = useState(0)
  return (
    <main>
      <Fc ref={r} show={n > 0} />
      <button onClick={() => setN(n + 1)}>{n}</button>
    </main>
  )
}
