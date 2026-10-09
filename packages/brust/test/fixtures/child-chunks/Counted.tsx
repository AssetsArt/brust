// useId ⇒ an instances[] record on the parent; useState ⇒ its own chunk; renders Deep too.
import { useId, useState } from 'react'
import Deep from './Deep'

export default function Counted() {
  const id = useId()
  const [n, setN] = useState(0)
  return (
    <div>
      <button id={id} onClick={() => setN(n + 1)}>
        {n}
      </button>
      <Deep />
    </div>
  )
}
