import { useState } from 'react'
import { Fb } from './Fwd'

// a callback ref under a condition: the mount effect cannot follow a branch that mounts later
export default function P() {
  const [el, setEl] = useState<HTMLButtonElement | null>(null)
  const [n, setN] = useState(0)
  return (
    <main>
      {n > 0 && <Fb ref={setEl}>{el ? 'bound' : 'x'}</Fb>}
      <button onClick={() => setN(n + 1)}>{n}</button>
    </main>
  )
}
