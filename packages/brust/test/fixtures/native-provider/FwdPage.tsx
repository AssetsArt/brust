import { useEffect, useRef, useState } from 'react'
import { Fb } from './Fwd'

// F267: `ref={r}` (a ref cell) and `ref={setEl}` (a callback) on an inlined forwardRef child land on its own <button>
export default function FwdPage() {
  const r = useRef<HTMLButtonElement>(null)
  const [el, setEl] = useState<HTMLButtonElement | null>(null)
  const [n, setN] = useState(0)
  useEffect(() => {
    r.current?.setAttribute('data-bound', 'ref')
  }, [])
  useEffect(() => {
    el?.setAttribute('data-bound', 'callback')
  }, [el])
  return (
    <main>
      <Fb ref={r} onClick={() => setN(n + 1)}>
        one <i>{n}</i>
      </Fb>
      <Fb ref={setEl}>two</Fb>
    </main>
  )
}
