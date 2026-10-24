import { useState } from 'react'
import Field from './Field'

// Two Fields (two "roots") and one with a deterministic id; the counter makes the page interactive.
export default function Page() {
  const [n, setN] = useState(0)
  return (
    <main>
      <button type="button" onClick={() => setN(n + 1)}>{n}</button>
      <Field label="first" />
      <Field label="second" />
      <Field label="fixed" fixed="given" />
    </main>
  )
}
