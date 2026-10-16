import { useState } from 'react'

// B5: `...props.style` of the `...rest` object inside an object literal, with a computed size and literals.
export default function Field({ label, ...props }: { label: string; style?: React.CSSProperties } & Record<string, unknown>) {
  const [n, setN] = useState(1)
  const size = { width: n * 10, height: 5 }
  return (
    <div data-testid="box" onClick={() => setN(n + 1)}>
      <b>click</b>
      <input aria-label={label} style={{ ...props.style, ...size, position: 'absolute', opacity: 0 }} />
    </div>
  )
}
