import { useState } from 'react'
import Label from './Label'
import Thumb from './Thumb'

// F309: Label is static, the page links it (`on` changes), and the Thumb it prints reads the page's `on` too. Before the
// fix the Thumb was bound by Label's host and never updated; now the page is refused (slot-owner) and renders with React.
export default function Page() {
  const [on, setOn] = useState(false)
  return (
    <main>
      <button type="button" data-testid="flip" onClick={() => setOn(!on)}>flip</button>
      <Label on={on}>
        <Thumb on={on} />
      </Label>
    </main>
  )
}
