import { useState } from 'react'

// The first paint of the falsy values themselves.
export default function ZeroPage() {
  const [n, setN] = useState(0)
  const [m] = useState(NaN)
  const [items] = useState<string[]>([])
  const [s] = useState('')
  const [z] = useState(-0)
  return (
    <main>
      <p data-testid="zero" onClick={() => setN(n + 1)}>{n && <b>yes</b>}</p>
      <p data-testid="nan">{m && <b>yes</b>}</p>
      <p data-testid="len">{items.length && <b>list</b>}</p>
      <p data-testid="str">{s && <b>s</b>}</p>
      <p data-testid="negzero">{z && <b>z</b>}</p>
    </main>
  )
}
