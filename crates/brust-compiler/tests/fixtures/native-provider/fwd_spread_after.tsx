import { useRef, useState } from 'react'
import { Fb } from './Fwd'

// a spread of unknown keys after the ref could carry a `ref` of its own
export default function P(props: any) {
  const r = useRef<HTMLButtonElement>(null)
  const [n, setN] = useState(0)
  return (
    <main>
      <Fb ref={r} {...props} onClick={() => setN(n + 1)}>
        {n}
      </Fb>
    </main>
  )
}
