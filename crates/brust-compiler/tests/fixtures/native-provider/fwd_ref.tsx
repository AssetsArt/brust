import { useEffect, useRef, useState } from 'react'
import { Fb } from './Fwd'

export default function P() {
  const r = useRef<HTMLButtonElement>(null)
  const [n, setN] = useState(0)
  useEffect(() => {
    r.current?.setAttribute('data-bound', 'yes')
  }, [])
  return (
    <main>
      <Fb ref={r} onClick={() => setN(n + 1)}>
        go {n}
      </Fb>
    </main>
  )
}
