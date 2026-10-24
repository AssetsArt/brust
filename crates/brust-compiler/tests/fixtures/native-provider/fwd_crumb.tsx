import { useEffect, useRef, useState } from 'react'
import { Fb } from './Fwd'

// user refs spelled like the branch's callback-ref cells ($cr…) stay plain refs; the callback cell takes another name
export default function P() {
  const $crumb = useRef<HTMLDivElement>(null)
  const $cr1 = useRef<HTMLSpanElement>(null)
  const $crf = useRef<HTMLButtonElement>(null)
  const [el, setEl] = useState<HTMLElement | null>(null)
  const [n, setN] = useState(0)
  useEffect(() => {
    $crumb.current?.setAttribute('data-bound', 'yes')
  }, [])
  return (
    <main>
      <div ref={$crumb}>x</div>
      <Fb ref={$crf}>f</Fb>
      {n > 0 && <span ref={$cr1}>in</span>}
      {n > 0 && <b ref={setEl}>{el ? 'bound' : 'x'}</b>}
      <button onClick={() => setN(n + 1)}>{n}</button>
    </main>
  )
}
