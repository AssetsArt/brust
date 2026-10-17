import { useState } from 'react'
import Box from './Box'
// F344 (1): a host in list rows whose items come from state; the content reads the row value and page state.
export default function Page() {
  const [on, setOn] = useState(false)
  const [items, setItems] = useState([1, 2])
  return (
    <main>
      <button type="button" onClick={() => setOn(!on)}>f</button>
      <button type="button" onClick={() => setItems((xs) => [...xs, xs.length + 1])}>add</button>
      {items.map((i) => (
        <section key={i}>
          <Box>
            <b data-v={on ? i : -i}>r</b>
          </Box>
        </section>
      ))}
    </main>
  )
}
