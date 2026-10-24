import { useCallback, useEffect, useRef, useState } from 'react'

// F288 phase B review F1: user refs spelled like the compiler's branch callback-ref cells (`$cr…`), outside and inside a
// branch, next to a real callback ref in a branch. Each must be set as React sets it.
export default function CrumbPage() {
  const $crumb = useRef<HTMLDivElement>(null)
  const $cr1 = useRef<HTMLSpanElement>(null)
  const [n, setN] = useState(0)
  const mark = useCallback((el: HTMLElement | null) => {
    if (el) el.dataset.cb = 'on'
  }, [])
  useEffect(() => {
    $crumb.current?.setAttribute('data-bound', 'yes')
  }, [])
  useEffect(() => {
    $cr1.current?.setAttribute('data-bound', String(n))
  }, [n])
  return (
    <main>
      <div data-testid="crumb" ref={$crumb}>
        crumb
      </div>
      {n % 2 === 1 && (
        <span data-testid="cr1" ref={$cr1}>
          in
        </span>
      )}
      {n % 2 === 1 && (
        <b data-testid="cb" ref={mark}>
          cb
        </b>
      )}
      <button type="button" data-testid="toggle" onClick={() => setN(n + 1)}>
        {n}
      </button>
    </main>
  )
}
