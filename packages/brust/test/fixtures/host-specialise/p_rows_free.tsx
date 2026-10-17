import { useState } from 'react'
import RBox from './RBox'
// F344 (1): a host specialised inside list rows whose items come from state; the content reads page state only (no row
// value, no handler), so the clone is made; the host's own id is a row value. Rows are added and removed on the client.
export default function Page() {
  const [on, setOn] = useState(false)
  const [items, setItems] = useState([1, 2])
  return (
    <main>
      <button type="button" data-testid="f" onClick={() => setOn(!on)}>f</button>
      <button type="button" data-testid="add" onClick={() => setItems((xs) => [...xs, xs.length ? Math.max(...xs) + 1 : 1])}>add</button>
      <button type="button" data-testid="rm" onClick={() => setItems((xs) => xs.slice(1))}>rm</button>
      {items.map((i) => (
        <section key={i} data-row={i}>
          <RBox id={`b${i}`}>
            <b data-v={on ? 'on' : 'off'}>r</b>
          </RBox>
        </section>
      ))}
    </main>
  )
}
