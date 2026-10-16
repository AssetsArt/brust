import { useState } from 'react'
import Bubble from './Bubble'
import First from './First'
import Margin from './Margin'
import Sized from './Sized'

// F277: a parent whose state reaches a snapshot-only prop (Bubble, First) and a style object (Sized).
export default function Live() {
  const [on, setOn] = useState(true)
  const [w, setW] = useState(10)
  return (
    <section>
      <button
        type="button"
        data-testid="toggle"
        onClick={() => {
          setOn(!on)
          setW(w + 10)
        }}
      >
        {w}
      </button>
      <Bubble checked={on} />
      <First value={w} />
      <Sized name="s" style={{ width: w }} />
      <Margin style={{ width: w }} />
    </section>
  )
}
