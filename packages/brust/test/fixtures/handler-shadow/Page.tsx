import { useRef, useState } from 'react'

// F232: a binding named `a` read inside a handler. The generated handler wrapper once bound its rest arguments as `a`,
// so `a.current` was read off the arguments array (undefined) and the element never reached the log.
export default function Page() {
  const [n, setN] = useState(0)
  const a = useRef<HTMLButtonElement>(null)
  return (
    <button
      ref={a}
      data-testid="btn"
      onClick={() => {
        setN(n + 1)
        ;(window as unknown as { __seen: string[] }).__seen.push(a.current?.tagName ?? 'none')
      }}
    >
      {n}
    </button>
  )
}
