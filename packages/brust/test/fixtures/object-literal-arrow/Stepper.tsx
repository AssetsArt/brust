import { useState } from 'react'

// F178: local object-literal constants read by a handler and by the template.
export default function Stepper() {
  const [n, setN] = useState(0)
  const step = { up: 2, down: -1 }
  const label = { text: 'count', unit: n }
  return (
    <div data-testid="stepper">
      <button type="button" data-testid="up" onClick={() => setN(n + step.up)}>
        up
      </button>
      <button type="button" data-testid="down" onClick={() => setN(n + step.down)}>
        down
      </button>
      <output data-testid="out" data-unit={label.unit}>
        {label.text}: {label.unit}
      </output>
    </div>
  )
}
