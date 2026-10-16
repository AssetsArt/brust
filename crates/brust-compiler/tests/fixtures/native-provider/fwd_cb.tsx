import { useEffect, useState } from 'react'
import { Fb } from './Fwd'

export default function P() {
  const [el, setEl] = useState<HTMLButtonElement | null>(null)
  const [n, setN] = useState(0)
  useEffect(() => {
    el?.setAttribute('data-bound', 'yes')
  }, [el])
  return (
    <main>
      <Fb ref={setEl} onClick={() => setN(n + 1)}>
        go {n}
      </Fb>
    </main>
  )
}
