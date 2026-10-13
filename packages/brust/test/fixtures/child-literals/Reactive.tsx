import { useState } from 'react'
import Code from './Code'

// F96: state feeds the child's precomputed prop, so the page falls back to a React island.
export default function Reactive({ src }: { src: string }) {
  const [n, setN] = useState(0)
  return (
    <button type="button" onClick={() => setN(n + 1)}>
      <Code code={src + n} lang="ts" />
    </button>
  )
}
